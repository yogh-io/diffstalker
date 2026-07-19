/** Repo lifecycle: list, open (refcounted), close, worktrees. */

import { listWorktrees } from '@diffstalker/core/git/worktree';
import { Router, HttpError, sendJson } from '../router.js';
import { requireRepo, requireStringField, type RouteDeps } from './shared.js';

export function registerRepoRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

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

  router.get('/repos/:id/worktrees', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    // WorktreeInfo[] straight from `git worktree list --porcelain`: the
    // main worktree first, then linked ones (and a bare entry when the
    // repo uses a bare-worktree layout).
    sendJson(res, 200, await listWorktrees(handle.path));
  });

  router.delete('/repos/:id', ({ params, res }) => {
    requireRepo(registry, params.id);
    // On actual dispose the registry's onClosed callback tears down the
    // repo's SSE channel and broadcasts repo-closed on the daemon channel.
    registry.closeRepo(params.id);
    sendJson(res, 200, {});
  });
}
