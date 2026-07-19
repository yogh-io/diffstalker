/**
 * The diffstalker daemon: a Node http server exposing @diffstalker/core
 * behind a REST API + SSE.
 *
 * Binds a unix socket by default, or a TCP port (localhost only unless a
 * host is given).
 *
 * TODO: bearer-token auth before this ever binds beyond localhost.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import type { Socket } from 'node:net';
import { getDiff, getDiffForUntracked } from '@diffstalker/core/git/diff';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';
import type { WorkingTreeManager } from '@diffstalker/core/managers/WorkingTreeManager';
import { Router, HttpError, sendJson } from './router.js';
import { RepoRegistry, RepoHandle } from './repoRegistry.js';
import { SseHub } from './sse.js';
import { serializeSharedState } from './serialize.js';

export interface ListenOptions {
  socketPath?: string;
  port?: number;
  host?: string;
}

export interface Daemon {
  listen(options: ListenOptions): Promise<void>;
  close(): Promise<void>;
}

function requireStringField(body: unknown, field: string): string {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, `Expected a JSON body with "${field}"`);
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `Missing "${field}" (string) in body`);
  }
  return value;
}

/**
 * Current status, refreshing first when the manager has never loaded one.
 */
async function ensureStatus(workingTree: WorkingTreeManager): Promise<GitStatus> {
  if (!workingTree.state.status) {
    await workingTree.refresh();
  }
  const status = workingTree.state.status;
  if (!status) {
    throw new HttpError(500, 'Repository status unavailable');
  }
  return status;
}

/**
 * Find the status entry for a path. Prefers the side the operation targets
 * (unstaged entry for stage, staged entry for unstage) when a file appears
 * on both sides.
 */
function resolveFileEntry(status: GitStatus, filePath: string, preferStaged: boolean): FileEntry {
  const entries = status.files.filter((f) => f.path === filePath);
  if (entries.length === 0) {
    throw new HttpError(404, `File not in status: ${filePath}`);
  }
  return entries.find((f) => f.staged === preferStaged) ?? entries[0];
}

export function createDaemon(): Daemon {
  const registry = new RepoRegistry();
  const sse = new SseHub();
  const router = new Router();

  const requireRepo = (id: string): RepoHandle => {
    const handle = registry.getRepo(id);
    if (!handle) {
      throw new HttpError(404, `Unknown repo id: ${id}`);
    }
    return handle;
  };

  router.get('/health', ({ res }) => {
    sendJson(res, 200, { ok: true, ready: true });
  });

  router.get('/repos', ({ res }) => {
    const repos = registry.listRepos().map((handle) => ({
      id: handle.id,
      path: handle.path,
      branch: handle.manager.workingTree.state.status?.branch.current ?? null,
    }));
    sendJson(res, 200, repos);
  });

  router.post('/repos', async ({ body, res }) => {
    const inputPath = requireStringField(body, 'path');
    let opened;
    try {
      opened = await registry.openRepo(inputPath);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (opened.created) {
      // Warm up status/hunk counts; errors land in manager state, not here.
      opened.handle.manager.workingTree.refresh().catch(() => {});
    }
    sendJson(res, opened.created ? 201 : 200, {
      id: opened.handle.id,
      path: opened.handle.path,
    });
  });

  router.delete('/repos/:id', ({ params, res }) => {
    requireRepo(params.id);
    const removed = registry.closeRepo(params.id);
    if (removed) {
      sse.closeRepo(params.id);
    }
    sendJson(res, 200, { success: true });
  });

  router.get('/repos/:id/status', async ({ params, res }) => {
    const handle = requireRepo(params.id);
    await ensureStatus(handle.manager.workingTree);
    sendJson(res, 200, serializeSharedState(handle.manager.workingTree.state));
  });

  router.get('/repos/:id/diff', async ({ params, query, res }) => {
    const handle = requireRepo(params.id);
    const filePath = query.get('path') ?? undefined;
    const staged = query.get('staged') === 'true';

    // Stateless: never touches the manager's per-client selection.
    let diff;
    if (filePath) {
      const status = await ensureStatus(handle.manager.workingTree);
      const isUntracked = status.files.some((f) => f.path === filePath && f.status === 'untracked');
      diff = isUntracked
        ? await getDiffForUntracked(handle.path, filePath)
        : await getDiff(handle.path, filePath, staged);
    } else {
      diff = await getDiff(handle.path, undefined, staged);
    }
    sendJson(res, 200, diff);
  });

  router.post('/repos/:id/stage', async ({ params, body, res }) => {
    const handle = requireRepo(params.id);
    const filePath = requireStringField(body, 'path');
    const status = await ensureStatus(handle.manager.workingTree);
    const entry = resolveFileEntry(status, filePath, false);
    await handle.manager.workingTree.stage(entry);
    sendJson(res, 200, { success: true });
  });

  router.post('/repos/:id/unstage', async ({ params, body, res }) => {
    const handle = requireRepo(params.id);
    const filePath = requireStringField(body, 'path');
    const status = await ensureStatus(handle.manager.workingTree);
    const entry = resolveFileEntry(status, filePath, true);
    await handle.manager.workingTree.unstage(entry);
    sendJson(res, 200, { success: true });
  });

  router.get('/repos/:id/events', ({ params, res }) => {
    const handle = requireRepo(params.id);
    sse.subscribe(params.id, handle.manager, res);
  });

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
    listen(options: ListenOptions): Promise<void> {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };

        if (options.socketPath) {
          // Remove a stale socket file from a previous run.
          fs.rmSync(options.socketPath, { force: true });
          boundSocketPath = options.socketPath;
          server.listen(options.socketPath, onListening);
        } else if (options.port !== undefined) {
          server.listen(options.port, options.host ?? '127.0.0.1', onListening);
        } else {
          reject(new Error('listen() requires a socketPath or a port'));
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
