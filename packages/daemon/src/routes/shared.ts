/**
 * Shared plumbing for the daemon's route modules: the dependency bundle
 * passed to every register function, repo/status resolution, request
 * validation (body fields, query params, path containment), and the
 * mapping from git/fs failures to HTTP statuses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { createGit } from '@diffstalker/core/git/gitClient';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';
import type { RemoteOperationState } from '@diffstalker/core/managers/RemoteOperationManager';
import type { WorkingTreeManager } from '@diffstalker/core/managers/WorkingTreeManager';
import { HttpError, sendJson } from '../router.js';
import type { RepoRegistry, RepoHandle } from '../repoRegistry.js';
import type { SseHub, DaemonEventHub } from '../sse.js';
import type { FollowController } from '../follow.js';
import type { VersionService } from '../version.js';
import type { SymbolPool } from '../symbols/pool.js';
import type { BlobSemaphore } from '../blobSemaphore.js';
import { serializeSharedState } from '../serialize.js';

/** Everything a route module needs, injected by createDaemon. */
export interface RouteDeps {
  registry: RepoRegistry;
  sse: SseHub;
  daemonEvents: DaemonEventHub;
  /** Null when follow mode is disabled (--no-follow). */
  follow: FollowController | null;
  /** Running-vs-published version, behind a cache (GET /version). */
  version: VersionService;
  /**
   * REST surface to expose. 'web' registers only what the web UI uses
   * (reads + repo open/release + file stage/unstage); 'full' adds the
   * CLI-only mutations. See DaemonOptions.apiMode.
   */
  apiMode: 'full' | 'web';
  /**
   * In-file symbols. Null when the grammars package is not installed or
   * did not verify — outlines are opt-in, and their absence is a normal
   * state reported through /health, not a degraded one.
   */
  symbols: SymbolSupport | null;
}

export interface SymbolSupport {
  pool: SymbolPool;
  /** Its own budget, deliberately not the blob gate's. */
  gate: BlobSemaphore;
  /** Extensions this install can outline. */
  extensions: string[];
}

/** Resolve a repo id to its handle or 404. */
export function requireRepo(registry: RepoRegistry, id: string): RepoHandle {
  const handle = registry.getRepo(id);
  if (!handle) {
    throw new HttpError(404, `Unknown repo id: ${id}`);
  }
  return handle;
}

/**
 * Require a string field on a JSON body. Empty strings are rejected unless
 * `allowEmpty` is set (used when a later, more specific validation owns
 * the emptiness error, e.g. validateCommit for commit messages).
 */
export function requireStringField(
  body: unknown,
  field: string,
  opts?: { allowEmpty?: boolean }
): string {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, `Expected a JSON body with "${field}"`);
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || (!opts?.allowEmpty && value.length === 0)) {
    throw new HttpError(400, `Missing "${field}" (string) in body`);
  }
  return value;
}

/**
 * Require a ref-like string field (branch name, commit hash). Flag-shaped
 * values (leading '-') are rejected so a name can never be parsed as a git
 * option — defense in depth on top of the end-of-options guards in core
 * (a branch "name" of -f once reached `git checkout -f` and discarded the
 * working tree).
 */
export function requireRefField(body: unknown, field: string): string {
  const value = requireStringField(body, field);
  if (value.startsWith('-')) {
    throw new HttpError(400, `Invalid "${field}" (must not start with "-"): ${value}`);
  }
  return value;
}

/** Optional string field on a JSON body; absent yields undefined. */
export function optionalStringField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `Invalid "${field}" (expected a non-empty string)`);
  }
  return value;
}

/**
 * Optional integer field on a JSON body with a lower bound; absent yields
 * the fallback.
 */
export function optionalIntField(
  body: unknown,
  field: string,
  opts: { min: number; fallback: number }
): number {
  if (typeof body !== 'object' || body === null) return opts.fallback;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined) return opts.fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < opts.min) {
    throw new HttpError(400, `Invalid "${field}" (expected an integer >= ${opts.min})`);
  }
  return value;
}

/** Optional boolean field on a JSON body; absent yields false. */
export function optionalBooleanField(body: unknown, field: string): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `Invalid "${field}" (expected a boolean)`);
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
 * An optional `max` bounds it above (a client asking for an unbounded
 * `count` would otherwise make the daemon buffer an arbitrarily large
 * result) — over the cap is a 400, not a silent clamp.
 */
export function parsePositiveIntParam(
  query: URLSearchParams,
  name: string,
  fallback: number,
  max?: number
): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, `Invalid "${name}" (expected a positive integer): ${raw}`);
  }
  if (max !== undefined && value > max) {
    throw new HttpError(400, `Invalid "${name}" (must be <= ${max}): ${raw}`);
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

/** True when `target` is `base` itself or lives inside it. */
function isAtOrUnder(target: string, base: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

/**
 * True for a path segment that addresses the git directory.
 *
 * Compared case-insensitively and with trailing dots and spaces stripped:
 * macOS (case-insensitive HFS+/APFS) and Windows both open the same
 * directory for ".git", ".GIT", ".git." and ".git ", so matching one
 * spelling matches one spelling out of many. Exported because the /tree
 * listing filters by the same rule.
 */
export function isGitDirSegment(segment: string): boolean {
  return segment.replace(/[. ]+$/, '').toLowerCase() === '.git';
}

/**
 * Lexical validation of a client-supplied repo-relative path, before any fs
 * or git call touches it. Returns the NORMALIZED relative path — that
 * normalized form is what callers must pass on, and what every check below
 * runs against.
 *
 * Checking the normalized form is the whole point: `./.git/config`,
 * `src/../.git/config` and `worktrees/x/.git/config` all slip past a check
 * on the raw string's first segment, and all reach the git config — which
 * carries credentials in remote URLs.
 *
 * Also refused: empty, a NUL byte (truncates a C-level path), a leading "-"
 * (git parses it as an option) and a leading ":" (git parses it as pathspec
 * magic, so `:(glob)**` would address blobs the guards never saw).
 */
export function requireRepoRelPath(repoPath: string, relPath: string): string {
  if (relPath.length === 0) {
    throw new HttpError(400, 'Empty path');
  }
  if (relPath.includes('\0')) {
    throw new HttpError(400, 'Path contains a NUL byte');
  }
  const root = path.resolve(repoPath);
  const rel = path.relative(root, path.resolve(root, relPath));
  if (rel === '') {
    throw new HttpError(400, `Path resolves to the repository root: ${relPath}`);
  }
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw new HttpError(400, `Path escapes repository root: ${relPath}`);
  }
  if (rel.startsWith('-')) {
    throw new HttpError(400, `Path must not start with "-": ${relPath}`);
  }
  if (rel.startsWith(':')) {
    throw new HttpError(400, `Path must not start with ":": ${relPath}`);
  }
  if (rel.split(path.sep).some(isGitDirSegment)) {
    throw new HttpError(400, `Path addresses the git directory: ${relPath}`);
  }
  return rel;
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
 * The repo's git directory, real path, resolved once per repo.
 *
 * A WeakMap on the handle keeps the cache alive exactly as long as the repo
 * is open. The pending promise is cached (not just the result) so parallel
 * requests share one git process, and it is dropped again on failure so a
 * transient one does not poison the repo for the daemon's lifetime.
 */
const gitDirCache = new WeakMap<RepoHandle, Promise<string>>();

async function absoluteGitDir(handle: RepoHandle): Promise<string> {
  let pending = gitDirCache.get(handle);
  if (!pending) {
    pending = (async () => {
      const raw = await createGit(handle.path).raw(['rev-parse', '--absolute-git-dir']);
      return await fs.promises.realpath(raw.trim());
    })();
    gitDirCache.set(handle, pending);
    pending.catch(() => gitDirCache.delete(handle));
  }
  try {
    return await pending;
  } catch {
    throw new HttpError(500, 'Cannot resolve the git directory for this repository');
  }
}

/**
 * Reject a path whose REAL location escapes the repo root, or lands in the
 * repo's git directory. Run it on the normalized path returned by
 * requireRepoRelPath — the pair is always used together, in that order.
 *
 * A symlink inside the repo pointing at /etc must not let /file or /tree
 * serve host files, and one pointing at .git must not serve the config: the
 * lexical ".git" refusal only sees spellings in the path itself, while
 * `git rev-parse --absolute-git-dir` names the real directory, which also
 * covers a linked worktree, a bare repo and a submodule's .git file.
 *
 * Nonexistent paths pass (the fs read 404s them properly later).
 */
export async function requireRealRepoPath(handle: RepoHandle, relPath: string): Promise<void> {
  const realRoot = await fs.promises.realpath(path.resolve(handle.path));
  const realTarget = await realpathOrNull(path.join(handle.path, relPath));
  if (realTarget === null) return;
  if (!isAtOrUnder(realTarget, realRoot)) {
    throw new HttpError(400, `Path escapes repository root: ${relPath}`);
  }
  if (isAtOrUnder(realTarget, await absoluteGitDir(handle))) {
    throw new HttpError(400, `Path addresses the git directory: ${relPath}`);
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
    if (real === null || isAtOrUnder(real, realRoot)) {
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
  return /index\.lock|did not match|conflict|apply|nothing to commit/i.test(message) ? 409 : 500;
}

/**
 * Run a staging mutation and translate the manager's swallowed-error model
 * to HTTP: the manager never rethrows, it records failures in state.error.
 * On failure respond 409/500 with {error}; on success refresh so the
 * response reflects the committed state, and return the unified mutation
 * envelope {state}.
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
  sendJson(res, 200, { state: serializeSharedState(workingTree.state) });
}

/**
 * Failures that mean the operation was legitimately refused by the current
 * repo/remote state (conflicts, rejected pushes, would-be-overwritten
 * checkouts) are 409s; anything else is a real failure, 500.
 */
function remoteErrorStatus(message: string): number {
  return /conflict|rejected|non-fast-forward|would be overwritten|merge|unmerged/i.test(message)
    ? 409
    : 500;
}

/**
 * Run a remote/branch/undo operation and translate the manager's
 * swallowed-error model to HTTP. Manager methods return their own outcome
 * snapshot, or null when another operation was already in progress — a
 * null (or an up-front inProgress read) is a 409; the snapshot is never
 * read from the shared slot, so a racing call can never claim another
 * operation's result as its own. On failure respond 409/500 with {error};
 * on success refresh the working tree and respond with the unified
 * mutation envelope {state, result}.
 */
export async function runRemoteMutation(
  handle: RepoHandle,
  res: http.ServerResponse,
  fn: () => Promise<RemoteOperationState | null>
): Promise<void> {
  const remote = handle.manager.remote;
  const busy = (): HttpError =>
    new HttpError(
      409,
      `A ${remote.remoteState.operation ?? 'remote'} operation is already in progress`
    );
  if (remote.remoteState.inProgress) {
    throw busy();
  }
  const outcome = await fn();
  if (outcome === null) {
    // Our call hit the manager's guard: another op won the race.
    throw busy();
  }
  if (outcome.error) {
    sendJson(res, remoteErrorStatus(outcome.error), { error: outcome.error });
    return;
  }
  // Unified mutation envelope: the client wants fresh status after a
  // pull/reset/cherry-pick, not just a result string. The manager only
  // *schedules* a refresh; await a real one so the state is current.
  const workingTree = handle.manager.workingTree;
  await workingTree.refresh();
  sendJson(res, 200, {
    state: serializeSharedState(workingTree.state),
    result: outcome.lastResult,
  });
}
