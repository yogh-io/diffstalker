/**
 * Shared plumbing for the daemon's route modules: the dependency bundle
 * passed to every register function, repo/status resolution, request
 * validation (body fields, query params, path containment), and the
 * mapping from git/fs failures to HTTP statuses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';
import type { WorkingTreeManager } from '@diffstalker/core/managers/WorkingTreeManager';
import { HttpError, sendJson } from '../router.js';
import type { RepoRegistry, RepoHandle } from '../repoRegistry.js';
import type { SseHub } from '../sse.js';
import { serializeSharedState } from '../serialize.js';

/** Everything a route module needs, injected by createDaemon. */
export interface RouteDeps {
  registry: RepoRegistry;
  sse: SseHub;
}

/** Resolve a repo id to its handle or 404. */
export function requireRepo(registry: RepoRegistry, id: string): RepoHandle {
  const handle = registry.getRepo(id);
  if (!handle) {
    throw new HttpError(404, `Unknown repo id: ${id}`);
  }
  return handle;
}

/** Require a non-empty string field on a JSON body. */
export function requireStringField(body: unknown, field: string): string {
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
 * Parse a boolean query param: only "true"/"false" are accepted, anything
 * else is a 400; an absent param yields the default.
 */
export function parseBoolParam(query: URLSearchParams, name: string, fallback: boolean): boolean {
  const raw = query.get(name);
  if (raw === null) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new HttpError(400, `Invalid "${name}" (expected true or false): ${raw}`);
}

/**
 * Parse a positive-integer query param; an absent param yields the default.
 */
export function parsePositiveIntParam(
  query: URLSearchParams,
  name: string,
  fallback: number
): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `Invalid "${name}" (expected a positive integer): ${raw}`);
  }
  return value;
}

/**
 * Current status, refreshing first when the manager has never loaded one.
 */
export async function ensureStatus(workingTree: WorkingTreeManager): Promise<GitStatus> {
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
export async function resolveFileEntry(
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
 * Reject a client-supplied relative path that lexically escapes the repo
 * root ("../", absolute paths) with a 400. Purely lexical — symlink
 * escapes are caught separately by requireRealWithinRoot.
 */
export function requireWithinRoot(repoPath: string, relPath: string): void {
  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, `Path escapes repository root: ${relPath}`);
  }
}

/** Realpath, or null when the path (or a link target) does not exist. */
async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Reject a path whose REAL location escapes the repo root: a symlink
 * inside the repo pointing at /etc must not let /file or /tree serve host
 * files. Nonexistent paths pass (the fs read 404s them properly later).
 */
export async function requireRealWithinRoot(repoPath: string, relPath: string): Promise<void> {
  const realRoot = await fs.promises.realpath(path.resolve(repoPath));
  const realTarget = await realpathOrNull(path.join(repoPath, relPath));
  if (realTarget === null) return;
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new HttpError(400, `Path escapes repository root: ${relPath}`);
  }
}

/**
 * Keep only listing entries whose real location stays inside the repo
 * root: symlinks pointing out of the repo are dropped rather than served.
 * Broken symlinks (no realpath) are kept — they cannot leak anything.
 */
export async function dropEntriesEscapingRoot<T extends { path: string }>(
  repoPath: string,
  entries: T[]
): Promise<T[]> {
  const realRoot = await fs.promises.realpath(path.resolve(repoPath));
  const kept: T[] = [];
  for (const entry of entries) {
    const real = await realpathOrNull(path.join(repoPath, entry.path));
    if (real === null || real === realRoot || real.startsWith(realRoot + path.sep)) {
      kept.push(entry);
    }
  }
  return kept;
}

/** The errno of an fs error, or null. */
export function fsErrorCode(err: unknown): string | null {
  return (err as NodeJS.ErrnoException | null)?.code ?? null;
}

/** Failures that stem from a concurrent index/worktree change are 409s. */
function gitErrorStatus(message: string): number {
  return /index\.lock|did not match|conflict|apply/i.test(message) ? 409 : 500;
}

/**
 * Run a staging mutation and translate the manager's swallowed-error model
 * to HTTP: the manager never rethrows, it records failures in state.error.
 * On failure respond 409/500 with {error}; on success refresh so the
 * response reflects the committed state, and return the shared state.
 */
export async function runStagingMutation(
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
