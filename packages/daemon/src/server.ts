/**
 * The diffstalker daemon: a Node http server exposing @diffstalker/core
 * behind a REST API + SSE.
 *
 * Handlers live in src/routes/ (one module per endpoint family); this file
 * only wires them to the http server and manages the listening socket.
 *
 * Binds a unix socket by default, or a TCP port bound to loopback
 * (127.0.0.1) — there is no option to bind a routable interface.
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
import { registerDaemonRoutes } from './routes/daemon.js';

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
  /** Bound address after listen(): AddressInfo for TCP, the path for a unix socket. */
  address(): AddressInfo | string | null;
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
   * Which slice of the REST API to expose (least privilege):
   *  - 'full' (default): every endpoint, including commit/discard/hunk
   *    staging and all remote/branch operations. This is the CLI's socket.
   *  - 'web': reads + repo open/release + file-level stage/unstage ONLY —
   *    exactly what the web UI uses. The destructive mutations the web
   *    never calls (commit, discard, hunk staging, push/fetch/pull/stash/
   *    branch/reset/cherry-pick/revert/abort/rebase, persisted compare
   *    base) are not routed at all, so a bound port cannot be driven to
   *    run them even if the origin guard were somehow bypassed.
   * The CLI entry point selects 'web' for a --port bind, 'full' otherwise.
   */
  apiMode?: 'full' | 'web';
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
  const router = new Router();

  const apiMode = options.apiMode ?? 'full';
  const version = createVersionService(
    options.updateCheck === false
      ? () => Promise.resolve(null)
      : options.fetchLatestVersion
  );
  const deps: RouteDeps = { registry, sse, daemonEvents, follow, apiMode, version };
  registerHealthRoutes(router);
  registerVersionRoutes(router, deps);
  registerRepoRoutes(router, deps);
  registerWorkingTreeRoutes(router, deps);
  registerHistoryCompareRoutes(router, deps);
  registerJournalRoutes(router, deps);
  // Remote/branch operations are CLI-only: the web UI never calls them, so
  // a 'web' daemon does not route them at all (least privilege).
  if (apiMode === 'full') {
    registerRemoteRoutes(router, deps);
  }
  registerExplorerRoutes(router, deps);
  registerDaemonRoutes(router, deps);

  follow?.start();

  const staticHandler = options.webRoot ? createStaticHandler(options.webRoot) : undefined;

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

  // Track open connections so close() can cut long-lived SSE streams.
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let boundSocketPath: string | null = null;

  return {
    address(): AddressInfo | string | null {
      return server.address();
    },

    getRepo(id: string): RepoHandle | undefined {
      return registry.getRepo(id);
    },

    async listen(options: ListenOptions): Promise<void> {
      if (options.socketPath) {
        // Refuse to clobber a live daemon: only unlink the socket file
        // when connecting to it fails (genuinely stale).
        if (await isSocketLive(options.socketPath)) {
          throw new Error(`diffstalkerd already running at ${options.socketPath}`);
        }
        fs.rmSync(options.socketPath, { force: true });
      }

      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        const onListening = (): void => {
          server.removeListener('error', onError);
          if (boundSocketPath) {
            // Owner-only, like the old CommandServer (umask covers the
            // creation race; chmod makes the final mode explicit).
            fs.chmodSync(boundSocketPath, 0o600);
          }
          resolve();
        };

        if (options.fd !== undefined) {
          // Inherited socket (systemd activation): the caller owns the
          // socket file — no unlink, no chmod.
          server.listen({ fd: options.fd }, onListening);
        } else if (options.socketPath) {
          boundSocketPath = options.socketPath;
          process.umask(0o077);
          server.listen(options.socketPath, onListening);
        } else if (options.port !== undefined) {
          server.listen(options.port, '127.0.0.1', onListening);
        } else {
          reject(new Error('listen() requires a socketPath, a port, or an fd'));
        }
      });
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
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (boundSocketPath) {
            fs.rmSync(boundSocketPath, { force: true });
          }
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
