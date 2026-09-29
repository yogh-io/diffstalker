/**
 * Daemon-scope routes (no repo id): the daemon-level SSE channel and the
 * follow-mode state.
 *
 * GET /events streams named events about the daemon itself — `snapshot`
 * (currently-open repos) on connect, then `repo-opened` / `repo-closed` as
 * clients open and close repos and `follow-change` when the hook file
 * points somewhere new — so every client keeps a fresh repo list and can
 * apply its own follow policy.
 *
 * With `?repo=<id>` the same stream also carries that repo's events (the
 * ones `GET /repos/:id/events` sends), so a browser tab needs one
 * connection instead of two — see the note in sse.ts on why that matters.
 * The order on connect is fixed: the daemon `snapshot` first, then the
 * repo's `repo-snapshot`. An id that is not open is not an error: the
 * stream still opens and says `repo-missing` after the snapshot, so a
 * reconnecting EventSource keeps the daemon events and the page can
 * re-open the repo.
 */

import { Router, sendJson } from '../router.js';
import { FOLLOW_DISABLED } from '../follow.js';
import type { RouteDeps } from './shared.js';

export function registerDaemonRoutes(router: Router, deps: RouteDeps): void {
  const { registry, sse, daemonEvents, follow } = deps;

  router.get('/events', ({ req, res, query }) => {
    const repos = registry.listRepos().map((handle) => ({
      id: handle.id,
      path: handle.path,
    }));
    daemonEvents.subscribe(req, res, repos);

    // An empty `repo=` is the same as no repo, not an unknown one.
    const repoId = query.get('repo');
    if (!repoId) return;
    // Not requireRepo: an unknown id must not 404 here (the headers are
    // already out, and EventSource would stop retrying on a non-200).
    sse.attach(repoId, registry.getRepo(repoId)?.manager ?? null, req, res);
  });

  router.get('/follow', ({ res }) => {
    sendJson(res, 200, follow ? follow.state : FOLLOW_DISABLED);
  });
}
