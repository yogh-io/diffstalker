/**
 * Working-tree routes: shared status, parameterized diffs, file-level
 * stage/unstage, and the SSE event stream.
 */

import { getDiff, getDiffForUntracked } from '@diffstalker/core/git/diff';
import { Router, HttpError, sendJson } from '../router.js';
import { serializeSharedState } from '../serialize.js';
import {
  ensureStatus,
  parseBoolParam,
  requireRepo,
  requireStringField,
  resolveFileEntry,
  runStagingMutation,
  type RouteDeps,
} from './shared.js';

export function registerWorkingTreeRoutes(router: Router, deps: RouteDeps): void {
  const { registry, sse } = deps;

  router.get('/repos/:id/status', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    await ensureStatus(handle.manager.workingTree);
    sendJson(res, 200, serializeSharedState(handle.manager.workingTree.state));
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
}
