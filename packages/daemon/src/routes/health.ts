/** The daemon liveness probe. */

import * as os from 'node:os';
import { Router, sendJson } from '../router.js';

export function registerHealthRoutes(router: Router): void {
  router.get('/health', ({ res }) => {
    // `home` lets web clients store repo paths relative to the daemon's
    // machine home, so a shareable URL drops the /home/<user> prefix.
    sendJson(res, 200, { ok: true, ready: true, home: os.homedir() });
  });
}
