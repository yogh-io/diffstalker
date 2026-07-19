/** The daemon liveness probe. */

import { Router, sendJson } from '../router.js';

export function registerHealthRoutes(router: Router): void {
  router.get('/health', ({ res }) => {
    sendJson(res, 200, { ok: true, ready: true });
  });
}
