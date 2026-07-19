/**
 * Daemon-scope routes (no repo id): the daemon-level SSE channel and the
 * follow-mode state.
 *
 * GET /events streams named events about the daemon itself — `snapshot`
 * (currently-open repos) on connect, then `repo-opened` / `repo-closed` as
 * clients open and close repos and `follow-change` when the hook file
 * points somewhere new — so every client keeps a fresh repo list and can
 * apply its own follow policy.
 */

import { Router, sendJson } from '../router.js';
import { FOLLOW_DISABLED } from '../follow.js';
import type { RouteDeps } from './shared.js';

export function registerDaemonRoutes(router: Router, deps: RouteDeps): void {
  const { registry, daemonEvents, follow } = deps;

  router.get('/events', ({ req, res }) => {
    const repos = registry.listRepos().map((handle) => ({
      id: handle.id,
      path: handle.path,
    }));
    daemonEvents.subscribe(req, res, repos);
  });

  router.get('/follow', ({ res }) => {
    sendJson(res, 200, follow ? follow.state : FOLLOW_DISABLED);
  });
}
