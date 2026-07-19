/**
 * The diffstalker daemon: a Node http server exposing @diffstalker/core
 * behind a REST API + SSE.
 *
 * Handlers live in src/routes/ (one module per endpoint family); this file
 * only wires them to the http server and manages the listening socket.
 *
 * Binds a unix socket by default, or a TCP port (localhost only unless a
 * host is given).
 *
 * TODO: bearer-token auth before this ever binds beyond localhost.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { Socket } from 'node:net';
import { Router } from './router.js';
import { RepoRegistry } from './repoRegistry.js';
import { SseHub } from './sse.js';
import type { RouteDeps } from './routes/shared.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerWorkingTreeRoutes } from './routes/workingTree.js';
import { registerHistoryCompareRoutes } from './routes/historyCompare.js';
import { registerRemoteRoutes } from './routes/remote.js';
import { registerExplorerRoutes } from './routes/explorer.js';

export interface ListenOptions {
  socketPath?: string;
  port?: number;
  host?: string;
  /** Inherited listening fd (systemd socket activation). The daemon does
   *  not create, chmod, or unlink anything for an inherited socket. */
  fd?: number;
}

export interface Daemon {
  listen(options: ListenOptions): Promise<void>;
  close(): Promise<void>;
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

export function createDaemon(): Daemon {
  const registry = new RepoRegistry();
  const sse = new SseHub();
  const router = new Router();

  const deps: RouteDeps = { registry, sse };
  registerHealthRoutes(router);
  registerRepoRoutes(router, deps);
  registerWorkingTreeRoutes(router, deps);
  registerHistoryCompareRoutes(router, deps);
  registerRemoteRoutes(router, deps);
  registerExplorerRoutes(router, deps);

  const server = http.createServer((req, res) => {
    // handle() never rejects (it converts errors to JSON responses), but
    // a floating rejection here would crash the daemon — belt and braces.
    router.handle(req, res).catch(() => res.end());
  });

  // Track open connections so close() can cut long-lived SSE streams.
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let boundSocketPath: string | null = null;

  return {
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
          server.listen(options.port, options.host ?? '127.0.0.1', onListening);
        } else {
          reject(new Error('listen() requires a socketPath, a port, or an fd'));
        }
      });
    },

    close(): Promise<void> {
      sse.destroy();
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
