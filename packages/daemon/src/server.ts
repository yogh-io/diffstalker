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
import * as net from 'node:net';
import * as path from 'node:path';
import type { Socket } from 'node:net';
import {
  getDiff,
  getDiffForUntracked,
  getCommitDiff,
  getDiffBetweenRefs,
  getCompareDiffWithUncommitted,
  getCandidateBaseBranches,
  getDefaultBaseBranch,
} from '@diffstalker/core/git/diff';
import type { CompareDiff } from '@diffstalker/core/git/diff';
import { getCommitHistory, getLocalBranches, listAllFiles } from '@diffstalker/core/git/status';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';
import {
  buildGitStatusMap,
  listDirectory,
  readFileForDisplay,
} from '@diffstalker/core/git/explorerData';
import {
  getCachedBaseBranch,
  setCachedBaseBranch,
} from '@diffstalker/core/utils/baseBranchCache';
import type { WorkingTreeManager } from '@diffstalker/core/managers/WorkingTreeManager';
import { Router, HttpError, sendJson } from './router.js';
import { RepoRegistry, RepoHandle } from './repoRegistry.js';
import { SseHub } from './sse.js';
import { serializeSharedState } from './serialize.js';

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
 * on both sides. Returns null when the path is not in status.
 */
function findFileEntry(status: GitStatus, filePath: string, preferStaged: boolean): FileEntry | null {
  const entries = status.files.filter((f) => f.path === filePath);
  if (entries.length === 0) return null;
  return entries.find((f) => f.staged === preferStaged) ?? entries[0];
}

/**
 * Resolve a path to a status entry, refreshing once when it is missing
 * from the cached status (the watcher may simply not have caught up yet)
 * before concluding 404.
 */
async function resolveFileEntry(
  workingTree: WorkingTreeManager,
  filePath: string,
  preferStaged: boolean
): Promise<FileEntry> {
  let status = await ensureStatus(workingTree);
  let entry = findFileEntry(status, filePath, preferStaged);
  if (!entry) {
    await workingTree.refresh();
    status = await ensureStatus(workingTree);
    entry = findFileEntry(status, filePath, preferStaged);
  }
  if (!entry) {
    throw new HttpError(404, `File not in status: ${filePath}`);
  }
  return entry;
}

/**
 * Reject a client-supplied relative path that escapes the repo root with a
 * 400 (same guard as getDiffForUntracked's, surfaced as a client error).
 */
function requireWithinRoot(repoPath: string, relPath: string): void {
  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, `Path escapes repository root: ${relPath}`);
  }
}

/** True for fs errors that mean the path does not exist. */
function isFsNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Failures that stem from a concurrent index/worktree change are 409s. */
function gitErrorStatus(message: string): number {
  return /index\.lock|did not match|conflict|apply/i.test(message) ? 409 : 500;
}

/**
 * Effective compare base for a repo: the persisted per-repo choice (shared
 * repo-level config, not per-client selection) or the discovered default.
 */
async function resolveBaseBranch(repoPath: string): Promise<string | null> {
  return getCachedBaseBranch(repoPath) ?? (await getDefaultBaseBranch(repoPath));
}

/**
 * Run a staging mutation and translate the manager's swallowed-error model
 * to HTTP: the manager never rethrows, it records failures in state.error.
 * On failure respond 409/500 with {error}; on success refresh so the
 * response reflects the committed state, and return the shared state.
 */
async function runStagingMutation(
  workingTree: WorkingTreeManager,
  res: http.ServerResponse,
  mutate: () => Promise<void>
): Promise<void> {
  // Reset the error slot first so a stale message from an earlier failure
  // is not mistaken for this mutation's outcome.
  workingTree.clearError();
  await mutate();
  const error = workingTree.state.error;
  if (error) {
    sendJson(res, gitErrorStatus(error), { error });
    return;
  }
  await workingTree.refresh();
  sendJson(res, 200, serializeSharedState(workingTree.state));
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
    sendJson(res, 200, {});
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
      if (isUntracked && staged) {
        throw new HttpError(
          400,
          `staged=true is meaningless for untracked file: ${filePath} (untracked files have no staged diff)`
        );
      }
      diff = isUntracked
        ? await getDiffForUntracked(handle.path, filePath)
        : await getDiff(handle.path, filePath, staged);
    } else {
      diff = await getDiff(handle.path, undefined, staged);
    }
    // Annotate hunks with edit times, same as diffs served to the TUI.
    handle.manager.workingTree.stampDiff(diff);
    sendJson(res, 200, diff);
  });

  // --- History + compare: stateless, on-demand reads over @diffstalker/core.
  // These call the plain git functions directly with the repo path — never
  // the managers' loadHistory/refreshCompareDiff/selection state, which is
  // per-client and stays client-side. Clients re-pull on the working-tree
  // `state-change` SSE event (the git watcher covers HEAD/refs).

  router.get('/repos/:id/history', async ({ params, query, res }) => {
    const handle = requireRepo(params.id);
    const countParam = query.get('count');
    let count = 100;
    if (countParam !== null) {
      count = Number(countParam);
      if (!Number.isInteger(count) || count < 1) {
        throw new HttpError(400, `count must be a positive integer: ${countParam}`);
      }
    }
    // CommitInfo dates are Date objects; sendJson's toWire turns them into
    // ISO strings.
    sendJson(res, 200, await getCommitHistory(handle.path, count));
  });

  router.get('/repos/:id/commits/:hash/diff', async ({ params, res }) => {
    const handle = requireRepo(params.id);
    const hash = params.hash;
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
      throw new HttpError(400, `Invalid commit hash: ${hash}`);
    }
    // Historical diff: deliberately NOT stamped with hunk edit times —
    // stamping only applies to the live working-tree diff.
    const diff = await getCommitDiff(handle.path, hash);
    // getCommitDiff swallows git errors and returns an empty result, so an
    // unknown hash and a truly empty commit look the same; treat empty as
    // not-found (empty commits are the far rarer case).
    if (diff.raw === '') {
      throw new HttpError(404, `Unknown commit: ${hash}`);
    }
    sendJson(res, 200, diff);
  });

  router.get('/repos/:id/branches', async ({ params, res }) => {
    const handle = requireRepo(params.id);
    sendJson(res, 200, await getLocalBranches(handle.path));
  });

  router.get('/repos/:id/base-branches', async ({ params, res }) => {
    const handle = requireRepo(params.id);
    sendJson(res, 200, await getCandidateBaseBranches(handle.path));
  });

  router.get('/repos/:id/compare/base', async ({ params, res }) => {
    const handle = requireRepo(params.id);
    sendJson(res, 200, { base: await resolveBaseBranch(handle.path) });
  });

  router.put('/repos/:id/compare/base', ({ params, body, res }) => {
    const handle = requireRepo(params.id);
    const branch = requireStringField(body, 'branch');
    setCachedBaseBranch(handle.path, branch);
    sendJson(res, 200, { base: branch });
  });

  router.get('/repos/:id/compare', async ({ params, query, res }) => {
    const handle = requireRepo(params.id);
    const base = query.get('base') ?? (await resolveBaseBranch(handle.path));
    if (!base) {
      throw new HttpError(400, 'no base branch');
    }
    const uncommitted = query.get('uncommitted') === 'true';
    // Response is the CompareDiff itself — consistent with /diff returning
    // the DiffResult directly. It already carries the resolved base as
    // `baseBranch`; uncommitted inclusion shows in `files[].isUncommitted`.
    let diff: CompareDiff;
    try {
      diff = uncommitted
        ? await getCompareDiffWithUncommitted(handle.path, base)
        : await getDiffBetweenRefs(handle.path, base);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // merge-base rejects an unknown/invalid base ref: a client error.
      if (/not a valid|unknown revision|bad revision/i.test(message)) {
        throw new HttpError(400, message);
      }
      throw err;
    }
    sendJson(res, 200, diff);
  });

  // --- Explorer: stateless data reads (directory listing with git status,
  // file content as flags, the file-finder source). The tree/selection
  // view-model stays client-side; explorer data is pulled on demand and the
  // working-tree `state-change` SSE event already signals changes.

  router.get('/repos/:id/tree', async ({ params, query, res }) => {
    const handle = requireRepo(params.id);
    const dir = query.get('dir') ?? '';
    requireWithinRoot(handle.path, dir);
    // Annotate from the manager's cached status (refreshing once when it
    // has never loaded), same source the TUI uses.
    const status = await ensureStatus(handle.manager.workingTree);
    const statusMap = buildGitStatusMap(status.files);
    let entries;
    try {
      entries = await listDirectory(handle.path, dir, undefined, statusMap);
    } catch (err) {
      if (isFsNotFound(err)) {
        throw new HttpError(404, `No such directory: ${dir || '/'}`);
      }
      throw err;
    }
    sendJson(res, 200, entries);
  });

  router.get('/repos/:id/file', async ({ params, query, res }) => {
    const handle = requireRepo(params.id);
    const relPath = query.get('path');
    if (!relPath) {
      throw new HttpError(400, 'Missing "path" query parameter');
    }
    requireWithinRoot(handle.path, relPath);
    try {
      sendJson(res, 200, await readFileForDisplay(handle.path, relPath));
    } catch (err) {
      if (isFsNotFound(err)) {
        throw new HttpError(404, `No such file: ${relPath}`);
      }
      if ((err as NodeJS.ErrnoException | null)?.code === 'EISDIR') {
        throw new HttpError(400, `Not a file: ${relPath}`);
      }
      throw err;
    }
  });

  router.get('/repos/:id/files', async ({ params, res }) => {
    const handle = requireRepo(params.id);
    sendJson(res, 200, await listAllFiles(handle.path));
  });

  router.post('/repos/:id/stage', async ({ params, body, res }) => {
    const handle = requireRepo(params.id);
    const filePath = requireStringField(body, 'path');
    const workingTree = handle.manager.workingTree;
    const entry = await resolveFileEntry(workingTree, filePath, false);
    await runStagingMutation(workingTree, res, () => workingTree.stage(entry));
  });

  router.post('/repos/:id/unstage', async ({ params, body, res }) => {
    const handle = requireRepo(params.id);
    const filePath = requireStringField(body, 'path');
    const workingTree = handle.manager.workingTree;
    const entry = await resolveFileEntry(workingTree, filePath, true);
    await runStagingMutation(workingTree, res, () => workingTree.unstage(entry));
  });

  router.get('/repos/:id/events', ({ params, req, res }) => {
    const handle = requireRepo(params.id);
    sse.subscribe(params.id, handle.manager, req, res);
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
