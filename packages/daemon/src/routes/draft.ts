/**
 * PR drafts (docs/work-page.md §3, §6): read, save and "start from this"
 * for one branch's draft, and the PR for that branch.
 *
 * The daemon writes `top.md` and `adopted` only; `top.suggested.md` and
 * `ai.md` are the agents' and are only read. None of these routes touches
 * git state, so both API modes carry them. `GET /repos/:id/pr` answers
 * from the cached PR list and never runs `gh`, so opening Compare never
 * does either. Two POSTs do run `gh`: `/pr/check` reads one PR fresh, and
 * `/pr/top` writes top.md into the PR's top zone, the one change to a PR
 * diffstalker makes, and only on the author's click (§3.6).
 */

import { resolveGitDirs } from '@diffstalker/core/git/worktree';
import {
  DraftBranchError,
  DraftConflictError,
  DraftFileError,
  adoptSuggestion,
  readDraft,
  writeDraftTop,
} from '@diffstalker/core/git/prDraft';
import { readGithubIdentities } from '@diffstalker/core/git/workScan';
import {
  MAX_DRAFT_BYTES,
  type BranchPr,
  type PrDraft,
  type PrInfo,
} from '@diffstalker/core/types/work';
import { countPlaceholders } from '@diffstalker/core/view/prBody';
import { GhError, TopZoneChangedError, type PrService } from '../github.js';
import { Router, HttpError, sendJson } from '../router.js';
import type { RepoHandle } from '../repoRegistry.js';
import {
  optionalRefParam,
  requireRefField,
  requireRepo,
  requireStringField,
  type RouteDeps,
} from './shared.js';

function requireBranchParam(query: URLSearchParams): string {
  const branch = optionalRefParam(query, 'branch');
  if (branch === null) throw new HttpError(400, 'Missing "branch" query parameter');
  return branch;
}

/** The repo's common git dir, where drafts live. requireRepo already answered 410 for a vanished repo. */
function commonDirOf(handle: RepoHandle): string {
  const dirs = resolveGitDirs(handle.path);
  if (dirs === null) throw new HttpError(500, 'Cannot find the git directory of this repository');
  return dirs.commonDir;
}

/** Run a draft operation; a refusal becomes its 4xx, anything else a 500 with its cause. */
async function draftCall(run: () => Promise<PrDraft>, failure: string): Promise<PrDraft> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DraftBranchError) throw new HttpError(400, err.message);
    if (err instanceof DraftConflictError) throw new HttpError(409, err.message);
    if (err instanceof DraftFileError) throw new HttpError(422, err.message);
    throw new HttpError(500, failure, { cause: err });
  }
}

async function identitiesOf(handle: RepoHandle): Promise<string[]> {
  try {
    return await readGithubIdentities(handle.path);
  } catch (err) {
    throw new HttpError(500, 'Could not read the remotes', { cause: err });
  }
}

/** The branch's PR from the cached list; 404 when the list has none. */
async function knownPr(prs: PrService, handle: RepoHandle, branch: string): Promise<PrInfo> {
  const pr = prs.prFor(await identitiesOf(handle), branch);
  if (pr === null) throw new HttpError(404, 'No PR is known for this branch');
  return pr;
}

/** A `gh` failure as the status the client shows. */
function ghFailure(err: unknown): HttpError {
  if (err instanceof TopZoneChangedError) return new HttpError(409, err.message);
  if (err instanceof GhError) {
    const status = err.kind === 'failed' ? 502 : 503;
    return new HttpError(status, err.message, { cause: err });
  }
  return new HttpError(500, 'Could not reach GitHub', { cause: err });
}

function branchPrAnswer(prs: PrService, pr: PrInfo | null): BranchPr {
  const snapshot = prs.snapshot();
  return {
    pr,
    status: snapshot.status,
    message: snapshot.message,
    checkedAt: snapshot.checkedAt,
    viewer: snapshot.viewer,
  };
}

export function registerDraftRoutes(router: Router, deps: RouteDeps): void {
  const { registry, prs } = deps;

  router.get('/repos/:id/draft', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireBranchParam(query);
    const commonDir = commonDirOf(handle);
    sendJson(
      res,
      200,
      await draftCall(() => readDraft(commonDir, branch), 'Could not read the draft')
    );
  });

  router.put('/repos/:id/draft', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireRefField(body, 'branch');
    const top = requireStringField(body, 'top', { allowEmpty: true });
    const version = requireStringField(body, 'version');
    if (Buffer.byteLength(top, 'utf8') > MAX_DRAFT_BYTES) {
      throw new HttpError(413, `Draft is larger than ${MAX_DRAFT_BYTES} bytes`);
    }
    const commonDir = commonDirOf(handle);
    const draft = await draftCall(
      () => writeDraftTop(commonDir, branch, top, version),
      'Could not save the draft'
    );
    sendJson(res, 200, draft);
  });

  router.post('/repos/:id/draft/adopt', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireRefField(body, 'branch');
    const version = requireStringField(body, 'version');
    const commonDir = commonDirOf(handle);
    const draft = await draftCall(
      () => adoptSuggestion(commonDir, branch, version),
      'Could not save the draft'
    );
    sendJson(res, 200, draft);
  });

  router.get('/repos/:id/pr', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireBranchParam(query);
    const pr = prs.prFor(await identitiesOf(handle), branch);
    sendJson(res, 200, branchPrAnswer(prs, pr));
  });

  // POST: it runs gh, and a GET would let any page make the daemon do that.
  router.post('/repos/:id/pr/check', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireRefField(body, 'branch');
    const pr = await knownPr(prs, handle, branch);
    let fresh: PrInfo;
    try {
      fresh = await prs.checkOne(pr);
    } catch (err) {
      throw ghFailure(err);
    }
    sendJson(res, 200, branchPrAnswer(prs, fresh));
  });

  router.post('/repos/:id/pr/top', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const branch = requireRefField(body, 'branch');
    const version = requireStringField(body, 'version');
    const expectedTop = requireStringField(body, 'expectedTop', { allowEmpty: true });
    const commonDir = commonDirOf(handle);
    const draft = await draftCall(() => readDraft(commonDir, branch), 'Could not read the draft');
    if (draft.version !== version) {
      throw new HttpError(409, 'top.md changed since it was shown');
    }
    const top = draft.top ?? '';
    if (top.trim() === '') throw new HttpError(422, 'top.md is empty: there is nothing to send');
    if (countPlaceholders(top) > 0) {
      throw new HttpError(422, 'top.md still has a {{...}} placeholder');
    }
    const pr = await knownPr(prs, handle, branch);
    if (pr.state !== 'open') throw new HttpError(409, 'The PR is not open');
    let fresh: PrInfo;
    try {
      fresh = await prs.setTopZone(pr, top, expectedTop);
    } catch (err) {
      throw ghFailure(err);
    }
    sendJson(res, 200, branchPrAnswer(prs, fresh));
  });
}
