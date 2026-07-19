/** Repo lifecycle: list, open (refcounted), close. */

import { Router, HttpError, sendJson } from '../router.js';
import { requireRepo, requireStringField, type RouteDeps } from './shared.js';

export function registerRepoRoutes(router: Router, deps: RouteDeps): void {
  const { registry, sse } = deps;

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
    requireRepo(registry, params.id);
    const removed = registry.closeRepo(params.id);
    if (removed) {
      sse.closeRepo(params.id);
    }
    sendJson(res, 200, {});
  });
}
