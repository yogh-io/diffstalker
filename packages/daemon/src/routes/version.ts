/**
 * GET /version — the running daemon version against the latest published
 * on npm, so clients can show an "up to date / update available" hint.
 *
 * Available in both API modes: it is a read, and the web UI is its main
 * consumer.
 */

import { Router, sendJson } from '../router.js';
import type { RouteDeps } from './shared.js';

export function registerVersionRoutes(router: Router, deps: RouteDeps): void {
  router.get('/version', async ({ res }) => {
    sendJson(res, 200, await deps.version.state());
  });
}
