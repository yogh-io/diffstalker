/** The daemon liveness probe. */

import * as os from 'node:os';
import { Router, sendJson } from '../router.js';
import type { RouteDeps } from './shared.js';

export function registerHealthRoutes(router: Router, deps: RouteDeps): void {
  router.get('/health', ({ res }) => {
    // `home` lets web clients store repo paths relative to the daemon's
    // machine home, so a shareable URL drops the /home/<user> prefix.
    //
    // `symbols.extensions` is the outline capability, derived from grammars
    // actually PRESENT and checksum-verified — never from the static
    // language map, which would let a build advertise grammars it does not
    // ship. Empty means the opt-in grammars package is not installed, and
    // that is what a client shows an install hint from.
    // `http.port` is the loopback port the web UI is reachable on, or null
    // when this daemon bound only a socket. A socket client (the CLI, for
    // `diffstalker link`) cannot otherwise know a browser URL exists at
    // all, and guessing one produces links that fail by landing nowhere.
    // Read live, not captured: routes are registered before listen().
    sendJson(res, 200, {
      ok: true,
      ready: true,
      home: os.homedir(),
      http: { port: deps.httpPort() },
      symbols: { extensions: deps.symbols?.extensions ?? [] },
    });
  });
}
