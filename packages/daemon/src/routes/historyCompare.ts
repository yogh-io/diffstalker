/**
 * History + compare routes: stateless, on-demand reads over
 * @diffstalker/core. These call the plain git functions directly with the
 * repo path — never the managers' loadHistory/refreshCompareDiff/selection
 * state, which is per-client and stays client-side. Clients re-pull on the
 * working-tree `state-change` SSE event (the git watcher covers HEAD/refs).
 */

import {
  commitExists,
  getCommitDiff,
  getDiffBetweenRefs,
  getCompareDiffWithUncommitted,
  getCandidateBaseBranches,
  getDefaultBaseBranch,
  resolveEffectiveBaseBranch,
  NoCommonHistoryError,
} from '@diffstalker/core/git/diff';
import type { CompareDiff } from '@diffstalker/core/git/diff';
import { getCommitHistory, getHeadMessage, getLocalBranches } from '@diffstalker/core/git/status';
import {
  getCachedBaseBranch,
  setCachedBaseBranch,
} from '@diffstalker/core/utils/baseBranchCache';
import { Router, HttpError, sendJson } from '../router.js';
import {
  parseBoolParam,
  parsePositiveIntParam,
  requireRepo,
  requireRefField,
  type RouteDeps,
} from './shared.js';

/**
 * The base to compare against when the request names none: the persisted
 * choice or the discovered default, verified to actually resolve. A stale
 * persisted choice falls back to the discovered default; when nothing
 * usable remains this is a 422 (server-side state, never the client's
 * fault — a base-less request must not 400).
 */
async function resolveUsableBaseBranch(repoPath: string): Promise<string> {
  const effective = await resolveEffectiveBaseBranch(repoPath);
  if (effective && (await commitExists(repoPath, effective))) {
    return effective;
  }
  if (getCachedBaseBranch(repoPath)) {
    // The persisted choice is unresolvable (deleted branch, corrupt
    // cache): fall back to the discovered default rather than erroring.
    const fallback = await getDefaultBaseBranch(repoPath);
    if (fallback && (await commitExists(repoPath, fallback))) {
      return fallback;
    }
  }
  throw new HttpError(422, 'No usable base branch');
}

export function registerHistoryCompareRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.get('/repos/:id/history', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const count = parsePositiveIntParam(query, 'count', 100, 5000);
    // CommitInfo dates are Date objects; sendJson's toWire turns them into
    // ISO strings.
    sendJson(res, 200, await getCommitHistory(handle.path, count));
  });

  router.get('/repos/:id/commits/:hash/diff', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    const hash = params.hash;
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
      throw new HttpError(400, `Invalid commit hash: ${hash}`);
    }
    // Existence and emptiness are distinct: merge commits (no --cc/-m,
    // matching the CLI's rendering) and --allow-empty commits legitimately
    // produce an empty diff and must be 200, not "Unknown commit".
    if (!(await commitExists(handle.path, hash))) {
      throw new HttpError(404, `Unknown commit: ${hash}`);
    }
    // Historical diff: deliberately NOT stamped with hunk edit times —
    // stamping only applies to the live working-tree diff.
    sendJson(res, 200, await getCommitDiff(handle.path, hash));
  });

  router.get('/repos/:id/head-message', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    // The exact `git log -1` message the TUI prefills for amend — served
    // via core's getHeadMessage, never approximated from /history. A repo
    // with no commits yields "" (getHeadMessage swallows the git error).
    sendJson(res, 200, { message: await getHeadMessage(handle.path) });
  });

  router.get('/repos/:id/branches', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    sendJson(res, 200, await getLocalBranches(handle.path));
  });

  router.get('/repos/:id/base-branches', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    sendJson(res, 200, await getCandidateBaseBranches(handle.path));
  });

  router.get('/repos/:id/compare/base', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    sendJson(res, 200, { base: await resolveEffectiveBaseBranch(handle.path) });
  });

  router.put('/repos/:id/compare/base', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireRefField(body, 'branch');
    // Validate before persisting: the cache is shared repo-level state
    // (the TUI's compare tab reads it too), so garbage must never land.
    if (!(await commitExists(handle.path, branch))) {
      throw new HttpError(400, `Not a valid base ref: ${branch}`);
    }
    setCachedBaseBranch(handle.path, branch);
    sendJson(res, 200, { base: branch });
  });

  router.get('/repos/:id/compare', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const uncommitted = parseBoolParam(query, 'uncommitted', false);

    const requestedBase = query.get('base');
    let base: string;
    if (requestedBase !== null) {
      // A client-named base that does not resolve is the client's error.
      if (!(await commitExists(handle.path, requestedBase))) {
        throw new HttpError(400, `Unknown base ref: ${requestedBase}`);
      }
      base = requestedBase;
    } else {
      base = await resolveUsableBaseBranch(handle.path);
    }

    // Response is the CompareDiff itself — consistent with /diff returning
    // the DiffResult directly. It already carries the resolved base as
    // `baseBranch`; uncommitted inclusion shows in `files[].isUncommitted`.
    let diff: CompareDiff;
    try {
      diff = uncommitted
        ? await getCompareDiffWithUncommitted(handle.path, base)
        : await getDiffBetweenRefs(handle.path, base);
    } catch (err) {
      // A resolvable base with no shared history: a real, non-empty
      // answer ("nothing to compare"), not a silent empty diff.
      if (err instanceof NoCommonHistoryError) {
        throw new HttpError(422, err.message);
      }
      throw err;
    }
    sendJson(res, 200, diff);
  });
}
