/**
 * Working-tree routes: shared status, parameterized diffs, file-level
 * stage/unstage, and the SSE event stream.
 */

import { getDiff, getDiffForUntracked } from '@diffstalker/core/git/diff';
import { getInProgressOperation } from '@diffstalker/core/git/status';
import {
  validateCommit,
  formatCommitMessage,
} from '@diffstalker/core/services/commitService';
import type { WorkingTreeManager } from '@diffstalker/core/managers/WorkingTreeManager';
import { Router, HttpError, sendJson } from '../router.js';
import { serializeSharedState } from '../serialize.js';
import {
  ensureStatus,
  optionalBooleanField,
  parseBoolParam,
  requireRepo,
  requireStringField,
  resolveFileEntry,
  runStagingMutation,
  type RouteDeps,
} from './shared.js';

/**
 * Current staged-file count, refreshing once when it reads zero: the
 * cached status may simply predate an external `git add`, and a wrongly
 * rejected commit is worse than one extra refresh.
 */
async function currentStagedCount(workingTree: WorkingTreeManager): Promise<number> {
  const count = (files: { staged: boolean }[]): number => files.filter((f) => f.staged).length;
  let stagedCount = count((await ensureStatus(workingTree)).files);
  if (stagedCount === 0) {
    await workingTree.refresh();
    stagedCount = count((await ensureStatus(workingTree)).files);
  }
  return stagedCount;
}

export function registerWorkingTreeRoutes(router: Router, deps: RouteDeps): void {
  const { registry, sse } = deps;

  router.get('/repos/:id/status', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    await ensureStatus(handle.manager.workingTree);
    const state = serializeSharedState(handle.manager.workingTree.state);
    // Live override: the cached state may predate a pull that just wedged
    // the repo mid-rebase (the error path schedules no refresh), and a
    // polling client must see the wedge immediately, not on watcher timing.
    state.operationInProgress = await getInProgressOperation(handle.path);
    sendJson(res, 200, state);
  });

  router.get('/repos/:id/diff', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const filePath = query.get('path') ?? undefined;
    const staged = parseBoolParam(query, 'staged', false);

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

  router.post('/repos/:id/stage', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const filePath = requireStringField(body, 'path');
    const workingTree = handle.manager.workingTree;
    const entry = await resolveFileEntry(workingTree, filePath, false);
    await runStagingMutation(workingTree, res, () => workingTree.stage(entry));
  });

  router.post('/repos/:id/unstage', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const filePath = requireStringField(body, 'path');
    const workingTree = handle.manager.workingTree;
    const entry = await resolveFileEntry(workingTree, filePath, true);
    await runStagingMutation(workingTree, res, () => workingTree.unstage(entry));
  });

  router.get('/repos/:id/events', ({ params, req, res }) => {
    const handle = requireRepo(registry, params.id);
    sse.subscribe(params.id, handle.manager, req, res);
  });

  // CLI-only working-tree mutations: the web UI never bulk-stages, discards,
  // commits, or stages hunks, so a 'web' daemon does not route them at all.
  if (deps.apiMode === 'full') {
    registerWorkingTreeMutations(router, deps);
  }
}

/** The destructive working-tree routes, registered only for the full API. */
function registerWorkingTreeMutations(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.post('/repos/:id/stage-all', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    const workingTree = handle.manager.workingTree;
    await runStagingMutation(workingTree, res, () => workingTree.stageAll());
  });

  router.post('/repos/:id/unstage-all', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    const workingTree = handle.manager.workingTree;
    await runStagingMutation(workingTree, res, () => workingTree.unstageAll());
  });

  router.post('/repos/:id/discard', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const filePath = requireStringField(body, 'path');
    const workingTree = handle.manager.workingTree;
    const entry = await resolveFileEntry(workingTree, filePath, false);
    // The manager silently no-ops discard on a staged entry; a destructive
    // operation must not pretend to succeed, so reject it honestly.
    if (entry.staged) {
      throw new HttpError(409, `Cannot discard a staged file: ${filePath} (unstage it first)`);
    }
    await runStagingMutation(workingTree, res, () => workingTree.discard(entry));
  });

  router.post('/repos/:id/commit', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    // allowEmpty: an empty message is validateCommit's error to report,
    // with its specific message, not a generic missing-field 400.
    const message = requireStringField(body, 'message', { allowEmpty: true });
    const amend = optionalBooleanField(body, 'amend');
    const workingTree = handle.manager.workingTree;

    // Validate BEFORE touching git: empty message / nothing staged are
    // client errors (400), not git failures.
    const stagedCount = await currentStagedCount(workingTree);
    const validation = validateCommit(message, stagedCount, amend);
    if (!validation.valid) {
      throw new HttpError(400, validation.error ?? 'Invalid commit');
    }

    await runStagingMutation(workingTree, res, () =>
      workingTree.commit(formatCommitMessage(message), amend)
    );
  });

  router.post('/repos/:id/stage-hunk', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const patch = requireStringField(body, 'patch');
    const workingTree = handle.manager.workingTree;
    // The client ships the patch; a stale one makes `git apply --cached`
    // fail, which the mutation helper surfaces as a 409 — fail loud.
    await runStagingMutation(workingTree, res, () => workingTree.stageHunk(patch));
  });

  router.post('/repos/:id/unstage-hunk', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const patch = requireStringField(body, 'patch');
    const workingTree = handle.manager.workingTree;
    await runStagingMutation(workingTree, res, () => workingTree.unstageHunk(patch));
  });
}
