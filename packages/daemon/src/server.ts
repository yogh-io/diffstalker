/**
 * The diffstalker daemon: a Node http server exposing @diffstalker/core
 * behind a REST API + SSE.
 *
 * Handlers live in src/routes/ (one module per endpoint family); this file
 * only wires them to the http server and manages the listening socket.
 *
 * Binds a unix socket by default, and/or a TCP port bound to loopback
 * (127.0.0.1) — there is no option to bind a routable interface. Both at
 * once is the normal deployment: the TUI speaks REST over the socket while
 * a browser speaks REST over the port, against one shared git state.
 *
 * Each listener gets its own routing table, chosen by how well the
 * transport is protected (see modeFor): the socket is owner-only at the
 * filesystem layer and carries the full API, the port is reachable by any
 * local process and carries the web subset.
 *
 * TODO: bearer-token auth before this could ever bind beyond localhost.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { Router, sendJson } from './router.js';
import { createStaticHandler } from './staticFiles.js';
import { shouldGuard, guardRequest, SECURITY_HEADERS } from './security.js';
import { RepoRegistry, type RepoHandle } from './repoRegistry.js';
import { SseHub, DaemonEventHub } from './sse.js';
import { FollowController } from './follow.js';
import { createVersionService, type LatestVersionFetcher } from './version.js';
import type { RouteDeps } from './routes/shared.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerVersionRoutes } from './routes/version.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerWorkingTreeRoutes } from './routes/workingTree.js';
import { registerHistoryCompareRoutes } from './routes/historyCompare.js';
import { registerJournalRoutes } from './routes/journal.js';
import { registerRemoteRoutes } from './routes/remote.js';
import { registerExplorerRoutes } from './routes/explorer.js';
import { registerBlobRoutes } from './routes/blob.js';
import { registerDaemonRoutes } from './routes/daemon.js';
import { createBlobSemaphore } from './blobSemaphore.js';

/** Which slice of the REST API a listener exposes. */
export type ApiMode = 'full' | 'web';

/** How a single listener is bound. */
type BindKind = 'fd' | 'unix' | 'tcp';

/**
 * Where to listen. These are not mutually exclusive — supplying both a
 * socketPath and a port binds both, over one shared state.
 */
export interface ListenOptions {
  socketPath?: string;
  /** TCP port to bind. Always bound to loopback (127.0.0.1) — there is
   *  deliberately no host option, so the daemon can never be bound to a
   *  routable interface (it has no authentication; see security.ts). */
  port?: number;
  /** Inherited listening fd (systemd socket activation). The daemon does
   *  not create, chmod, or unlink anything for an inherited socket. */
  fd?: number;
}

export interface Daemon {
  listen(options: ListenOptions): Promise<void>;
  close(): Promise<void>;
  /**
   * The primary bound address after listen(): AddressInfo for TCP, the path
   * for a unix socket. With several listeners this is the first one bound
   * (fd, then unix, then tcp) — the CLI's transport when there is one.
   */
  address(): AddressInfo | string | null;
  /** Every bound address, in bind order. */
  addresses(): Array<AddressInfo | string>;
  /**
   * The live handle of an open repo (tests reach a repo's manager this
   * way — the daemon constructs managers itself, injecting the surviving
   * journal store, so core's path-keyed registry no longer knows them).
   */
  getRepo(id: string): RepoHandle | undefined;
}

export interface DaemonOptions {
  /**
   * Hook file to follow: the daemon watches it (creating it when missing)
   * and auto-opens whatever repo path is written to it, broadcasting
   * follow-change on the daemon-scope SSE channel. Omit to disable follow
   * mode entirely (no watcher is created) — the CLI entry point supplies
   * the default path unless --no-follow is given.
   */
  followFile?: string;
  /**
   * Directory with the built web UI (index.html + hashed assets). When set,
   * unmatched GET requests are served from it (SPA fallback); API routes
   * always win. Omit to serve the API only (unmatched GETs stay JSON 404s)
   * — the CLI entry point resolves the default location and logs when the
   * assets are missing.
   */
  webRoot?: string;
  /**
   * Force one slice of the REST API onto EVERY listener, overriding the
   * per-transport default (least privilege):
   *  - 'full': every endpoint, including commit/discard/hunk staging and
   *    all remote/branch operations. This is what a unix socket gets.
   *  - 'web': reads + repo open/release + file-level stage/unstage ONLY —
   *    exactly what the web UI uses. The destructive mutations the web
   *    never calls (commit, discard, hunk staging, push/fetch/pull/stash/
   *    branch/reset/cherry-pick/revert/abort/rebase, persisted compare
   *    base) are not routed at all, so a bound port cannot be driven to
   *    run them even if the origin guard were somehow bypassed.
   *
   * Omit it (the normal case) and each listener is graded by its own
   * protection: unix socket / inherited fd -> 'full', TCP port -> 'web'.
   * Setting it is for embedders and tests that want one known surface
   * regardless of transport.
   */
  apiMode?: ApiMode;
  /**
   * Whether GET /version may ask npm for the latest published version
   * (the daemon's only outbound request). Default true; --no-update-check
   * turns it off, and /version then reports latest: null / 'unknown'.
   */
  updateCheck?: boolean;
  /**
   * How to read the latest published version. Injected by tests so the
   * suite never hits the registry; production uses the npm dist-tags URL.
   */
  fetchLatestVersion?: LatestVersionFetcher;
}

/** True when something accepts connections on the unix socket path. */
function isSocketLive(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    // bun can throw connection errors synchronously (node emits them
    // async), so the connect call itself needs the try/catch too.
    try {
      const probe = net.connect(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        // ENOENT / ECONNREFUSED / EACCES: nothing live is answering there.
        probe.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
  const sse = new SseHub();
  const daemonEvents = new DaemonEventHub();
  const registry = new RepoRegistry({
    onOpened: (handle) =>
      daemonEvents.broadcast('repo-opened', { id: handle.id, path: handle.path }),
    onClosed: (id) => {
      // Real dispose (refcount hit zero): drop the repo's own SSE channel
      // and tell daemon-channel subscribers the repo list changed.
      sse.closeRepo(id);
      daemonEvents.broadcast('repo-closed', { id });
    },
  });
  const follow = options.followFile
    ? new FollowController(registry, daemonEvents, options.followFile)
    : null;
  const version = createVersionService(
    options.updateCheck === false ? () => Promise.resolve(null) : options.fetchLatestVersion
  );

  /**
   * One router per API mode, built on demand and cached.
   *
   * Least privilege here is enforced by route *registration*, not by a
   * per-request check: a 'web' router simply has no commit/discard/remote
   * handlers to reach. So a daemon serving both transports at once needs
   * two routing tables over one shared state, rather than one table that
   * asks permission on every call. Both close over the same registry, SSE
   * hubs, and follow controller — the state is single, only the surface
   * differs.
   */
  const routers = new Map<ApiMode, Router>();

  // One blob semaphore for the whole daemon, not one per router: a daemon
  // bound to both a socket and a port has two routing tables over one machine,
  // and the git processes and open fds they would spawn come out of the same
  // budget.
  const blobGate = createBlobSemaphore();

  function routerFor(mode: ApiMode): Router {
    const cached = routers.get(mode);
    if (cached) return cached;

    const router = new Router();
    const deps: RouteDeps = { registry, sse, daemonEvents, follow, apiMode: mode, version };
    registerHealthRoutes(router);
    registerVersionRoutes(router, deps);
    registerRepoRoutes(router, deps);
    registerWorkingTreeRoutes(router, deps);
    registerHistoryCompareRoutes(router, deps);
    registerJournalRoutes(router, deps);
    // Remote/branch operations are CLI-only: the web UI never calls them, so
    // a 'web' router does not route them at all (least privilege).
    if (mode === 'full') {
      registerRemoteRoutes(router, deps);
    }
    registerExplorerRoutes(router, deps);
    // Image bytes and their metadata are a web-UI feature, so they are
    // registered for BOTH modes — a --port daemon is exactly the one that
    // needs them.
    registerBlobRoutes(router, deps, blobGate);
    registerDaemonRoutes(router, deps);

    routers.set(mode, router);
    return router;
  }

  /**
   * Which surface a given transport gets. An explicit apiMode from the
   * embedder wins for every listener; otherwise it follows the transport's
   * own protection: a unix socket (or an inherited fd, which systemd
   * created with its own mode) is owner-only at the filesystem layer and
   * gets 'full', while a TCP port is reachable by any process on the host
   * and gets 'web'.
   */
  const modeFor = (kind: BindKind): ApiMode => options.apiMode ?? (kind === 'tcp' ? 'web' : 'full');

  follow?.start();

  const staticHandler = options.webRoot ? createStaticHandler(options.webRoot) : undefined;

  // Open connections across every listener, so close() can cut long-lived
  // SSE streams whichever transport they arrived on.
  const sockets = new Set<Socket>();

  interface Listener {
    server: http.Server;
    /** Socket file this daemon created, to unlink on close. Null for a TCP
     *  bind, and for an inherited fd (systemd owns that socket file). */
    socketPath: string | null;
  }
  const listeners: Listener[] = [];

  function createServer(mode: ApiMode): http.Server {
    const router = routerFor(mode);
    const server = http.createServer((req, res) => {
      // Security headers on every response, from one choke point (persist
      // through the per-route writeHead, which merges rather than replaces).
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(name, value);
      }

      // Origin guard (CSRF + DNS-rebinding), only when bound to loopback —
      // the default, safe posture. A routable bind is operator-exposed and
      // out of this threat model (index.ts warns instead).
      if (shouldGuard(server.address())) {
        const blocked = guardRequest(req);
        if (blocked) {
          sendJson(res, blocked.status, { error: blocked.message });
          return;
        }
      }

      // handle() never rejects (it converts errors to JSON responses), but
      // a floating rejection here would crash the daemon — belt and braces.
      router.handle(req, res, staticHandler).catch(() => res.end());
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    return server;
  }

  /** Bind one transport, resolving once it accepts connections. */
  async function bindTarget(kind: BindKind, opts: ListenOptions): Promise<void> {
    const socketPath = kind === 'unix' ? (opts.socketPath ?? null) : null;
    if (socketPath) {
      // Refuse to clobber a live daemon: only unlink the socket file when
      // connecting to it fails (genuinely stale).
      if (await isSocketLive(socketPath)) {
        throw new Error(`diffstalkerd already running at ${socketPath}`);
      }
      fs.rmSync(socketPath, { force: true });
    }

    const entry: Listener = { server: createServer(modeFor(kind)), socketPath };
    // Recorded before listening, so if a later target fails to bind, close()
    // still tears down the ones that already came up.
    listeners.push(entry);

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      entry.server.once('error', onError);
      const onListening = (): void => {
        entry.server.removeListener('error', onError);
        if (socketPath) {
          // Owner-only, like the old CommandServer (umask covers the
          // creation race; chmod makes the final mode explicit).
          fs.chmodSync(socketPath, 0o600);
        }
        resolve();
      };

      if (kind === 'fd') {
        // Inherited socket (systemd activation): the caller owns the socket
        // file — no unlink, no chmod.
        entry.server.listen({ fd: opts.fd }, onListening);
      } else if (socketPath) {
        process.umask(0o077);
        entry.server.listen(socketPath, onListening);
      } else {
        entry.server.listen(opts.port, '127.0.0.1', onListening);
      }
    });
  }

  /** Close one listener, unlinking the socket file it created. */
  function closeListener(entry: Listener): Promise<void> {
    return new Promise((resolve, reject) => {
      entry.server.close((err) => {
        if (entry.socketPath) {
          fs.rmSync(entry.socketPath, { force: true });
        }
        // A listener that never came up is not a close failure.
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  return {
    address(): AddressInfo | string | null {
      // The primary listener. Binds are ordered fd, unix, tcp, so a daemon
      // serving both transports still reports the CLI's socket here and
      // single-bind callers see exactly what they always did.
      return listeners[0]?.server.address() ?? null;
    },

    addresses(): Array<AddressInfo | string> {
      return listeners
        .map((entry) => entry.server.address())
        .filter((addr): addr is AddressInfo | string => addr !== null);
    },

    getRepo(id: string): RepoHandle | undefined {
      return registry.getRepo(id);
    },

    async listen(opts: ListenOptions): Promise<void> {
      const kinds: BindKind[] = [];
      if (opts.fd !== undefined) kinds.push('fd');
      if (opts.socketPath) kinds.push('unix');
      if (opts.port !== undefined) kinds.push('tcp');
      if (kinds.length === 0) {
        throw new Error('listen() requires a socketPath, a port, or an fd');
      }
      // Sequential, not concurrent: a bind failure should report which
      // transport failed, and the socket-liveness check must not race.
      for (const kind of kinds) {
        await bindTarget(kind, opts);
      }
    },

    close(): Promise<void> {
      // Follow first: stops the watcher and releases its follow-ref before
      // the hubs and registry are torn down.
      follow?.dispose();
      sse.destroy();
      daemonEvents.destroy();
      registry.disposeAll();
      for (const socket of sockets) {
        socket.destroy();
      }
      return Promise.all(listeners.splice(0).map(closeListener)).then(() => {});
    },
  };
}
