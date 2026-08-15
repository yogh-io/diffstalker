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
  getCommitCountBetweenRefs,
  getCandidateBaseBranches,
  getDefaultBaseBranch,
  resolveEffectiveBaseBranch,
  getFileDiffInRange,
  WHOLE_FILE_CONTEXT,
  NoCommonHistoryError,
} from '@diffstalker/core/git/diff';
import type { CompareDiff, DiffRange } from '@diffstalker/core/git/diff';
import {
  getCommit,
  getCommitHistory,
  getHeadMessage,
  getLocalBranches,
} from '@diffstalker/core/git/status';
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

/**
 * The base a compare request reads against: the client's `?base=` when it
 * names one, otherwise the server-resolved default. Shared by /compare and
 * /compare/count so the tab count and the list it labels can never end up
 * measuring different bases.
 *
 * A client-named base that does not resolve is the client's error (400);
 * having no usable base at all is server-side state (422).
 */
async function resolveRequestedBase(repoPath: string, query: URLSearchParams): Promise<string> {
  const requestedBase = query.get('base');
  if (requestedBase === null) {
    return resolveUsableBaseBranch(repoPath);
  }
  if (!(await commitExists(repoPath, requestedBase))) {
    throw new HttpError(400, `Unknown base ref: ${requestedBase}`);
  }
  return requestedBase;
}

/** Widen the context to the whole file, or leave core's default alone. */
function contextOpts(whole: boolean): { context?: number } {
  return whole ? { context: WHOLE_FILE_CONTEXT } : {};
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

  // One commit by hash — what a shared link to a commit resolves through
  // when it names one older than any page of the log the client holds.
  router.get('/repos/:id/commits/:hash', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    const hash = params.hash;
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
      throw new HttpError(400, `Invalid commit hash: ${hash}`);
    }
    const commit = await getCommit(handle.path, hash);
    if (commit === null) throw new HttpError(404, `Unknown commit: ${hash}`);
    sendJson(res, 200, commit);
  });

  router.get('/repos/:id/commits/:hash/diff', async ({ params, query, res }) => {
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
    // `path` narrows to one file, and `whole` widens its context — the
    // read behind whole-file mode in History. The pathspec carries both
    // sides of a rename (core's getFileDiffInRange), because scoping to
    // the new path alone would report a rename as a plain add.
    const filePath = query.get('path') ?? undefined;
    const whole = parseBoolParam(query, 'whole', false);
    if (whole && !filePath) {
      throw new HttpError(400, 'whole=true requires a path (one file at a time)');
    }
    // Historical diff: deliberately NOT stamped with hunk edit times —
    // stamping only applies to the live working-tree diff.
    const diff = filePath
      ? await getFileDiffInRange(handle.path, { kind: 'commit', hash }, filePath, contextOpts(whole))
      : await getCommitDiff(handle.path, hash);
    sendJson(res, 200, diff);
  });

  /**
   * One file's diff inside a comparison — what the Compare stack needs for
   * whole-file mode, since it pulls the range whole and splits it
   * client-side and so has no per-file request of its own.
   *
   * `uncommitted=true` means the row sits against HEAD rather than against
   * the base: Compare's stack mixes the two, and they are genuinely
   * different comparisons.
   */
  router.get('/repos/:id/compare/file', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const filePath = query.get('path');
    if (!filePath) throw new HttpError(400, 'path is required');
    const whole = parseBoolParam(query, 'whole', false);
    const uncommitted = parseBoolParam(query, 'uncommitted', false);
    const range: DiffRange = uncommitted
      ? { kind: 'head' }
      : { kind: 'compare', base: await resolveRequestedBase(handle.path, query) };
    sendJson(
      res,
      200,
      await getFileDiffInRange(handle.path, range, filePath, contextOpts(whole))
    );
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

  // Persisting a base selection is CLI-only (the web reads the effective
  // base via GET above and passes its pick per-request as ?base=).
  if (deps.apiMode === 'full') {
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
  }

  /**
   * How many commits /compare would list, without building the diff. Lets a
   * client badge the compare tab from the moment a repo opens — the full
   * payload is far too expensive to pull just for a number, so the tab would
   * otherwise stay blank until the view is opened.
   */
  router.get('/repos/:id/compare/count', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const base = await resolveRequestedBase(handle.path, query);
    try {
      sendJson(res, 200, {
        baseBranch: base,
        commits: await getCommitCountBetweenRefs(handle.path, base),
      });
    } catch (err) {
      // Same 422 as /compare: no shared history is a real answer, and a
      // client must not render it as a count of zero.
      if (err instanceof NoCommonHistoryError) {
        throw new HttpError(422, err.message);
      }
      throw err;
    }
  });

  router.get('/repos/:id/compare', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const uncommitted = parseBoolParam(query, 'uncommitted', false);
    const base = await resolveRequestedBase(handle.path, query);

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
