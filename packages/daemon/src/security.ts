/**
 * Request-origin guard for the daemon.
 *
 * The daemon has no authentication (see server.ts). Its safe deployment is
 * loopback-only: a unix socket, or a TCP port bound to 127.0.0.1. But a
 * loopback TCP port is still reachable from the user's own browser, so two
 * browser-only attacks matter whenever the web UI mode is used:
 *
 *  - CSRF: a page the user visits can fire cross-origin `fetch()` at the
 *    port. It cannot READ the response (no CORS), but a state-changing
 *    request (discard, reset, push, open-repo) still lands. We block those
 *    by rejecting a cross-site `Sec-Fetch-Site` and a non-loopback `Origin`.
 *  - DNS rebinding: an attacker domain rebound to 127.0.0.1 becomes
 *    same-origin and could then READ file contents. We block it with a
 *    loopback `Host` allow-list — a rebound request still carries
 *    `Host: evil.com`.
 *
 * The guard runs whenever the daemon is bound to a loopback address — which
 * is the only thing the CLI can produce (a unix socket, or `--port` on
 * 127.0.0.1; there is no host option). The non-loopback branch below is
 * defence for a library embedder that binds a routable address through the
 * createDaemon API directly; the shipped binary never does.
 *
 * Non-browser clients (the CLI over @diffstalker/client, `curl`) send no
 * `Origin`/`Sec-Fetch-Site` and a loopback `Host`, so they pass untouched.
 *
 * One route needs more than that. `guardRequest` exempts GET from the
 * `Sec-Fetch-Site`/`Origin` checks by design (a cross-origin GET cannot read
 * its response), and `Host: 127.0.0.1` passes the loopback allow-list because
 * an attacker page sends the real loopback Host when it targets a `--port`
 * daemon by ip. A GET that returns image bytes is therefore reachable from any
 * page the developer happens to visit: `<img src="http://127.0.0.1:7337/...">`
 * leaks no bytes, but `load` vs `error` plus `naturalWidth`/`naturalHeight` is
 * an existence-and-dimension oracle over the user's repos. Two things close
 * that: `Cross-Origin-Resource-Policy: same-origin` (the browser drops the
 * response before it reaches the embedding page) and `guardImageSubresource`
 * (we refuse the request outright).
 *
 * `guardImageSubresource` is deliberately a SEPARATE predicate, not part of
 * `guardRequest`. It demands `Sec-Fetch-Dest: image`, and the SPA's own
 * `fetch()` sends `Sec-Fetch-Dest: empty` — folding it into the global guard
 * would 403 every JSON call the web UI makes.
 */

import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

export interface GuardBlock {
  status: number;
  message: string;
}

/** Strip an optional port and IPv6 brackets from a host/authority string. */
function hostnameOf(authority: string): string | null {
  try {
    // Wrapping in a URL handles host:port and [::1]:port uniformly.
    const h = new URL(`http://${authority}`).hostname.toLowerCase();
    // URL keeps IPv6 in brackets; normalize `[::1]` -> `::1`.
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

/** The hostname of a full Origin URL (`http://host:port`), or null. */
function originHostname(origin: string): string | null {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

/**
 * An exact dotted-quad IPv4 inside 127.0.0.0/8.
 *
 * Exact octets, never a `startsWith('127.')` prefix: `127.0.0.1.evil.com` is a
 * registrable PUBLIC domain name, so a prefix test hands an attacker exactly
 * the same-origin position the Host allow-list exists to deny.
 */
function isLoopbackIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return octets[0] === '127';
}

/**
 * A non-empty label under the `.localhost` TLD. RFC 6761 reserves that TLD and
 * the public DNS root never delegates it, so — unlike a `127.` prefix — a name
 * under it cannot be registered and rebound by an attacker. The length test
 * rejects the degenerate bare `.localhost`, which the URL parser will hand
 * back verbatim.
 */
function isUnderLocalhostTld(hostname: string): boolean {
  const suffix = '.localhost';
  return hostname.length > suffix.length && hostname.endsWith(suffix);
}

/**
 * A loopback hostname: localhost, a name under .localhost, 127.0.0.0/8, or ::1.
 *
 * Both callers pass a hostname the URL parser has already normalized, which is
 * what makes the exact comparisons enough: it lowercases, and it folds every
 * numeric IPv4 spelling (`127.1`, `2130706433`, `0x7f.0.0.1`) and every IPv6
 * spelling (`0:0:0:0:0:0:0:1`) onto one canonical form. A loopback spelling it
 * does NOT fold — `::ffff:127.0.0.1` stays `::ffff:7f00:1` — is rejected. That
 * is deliberate: nothing reaches the daemon under that name, and failing
 * closed on an exotic spelling costs nothing.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    isUnderLocalhostTld(hostname) ||
    isLoopbackIpv4(hostname)
  );
}

/** A loopback bind address, as reported by server.address(). */
export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || isLoopbackIpv4(address);
}

/**
 * Whether the origin guard should run for a server bound at `address`.
 * A unix socket (string address) is loopback by nature; a TCP bind counts
 * only when its address is loopback. A wildcard/routable bind (0.0.0.0,
 * ::, a LAN ip) is an operator-exposed daemon — out of scope here.
 */
export function shouldGuard(address: AddressInfo | string | null): boolean {
  if (address === null) return false;
  if (typeof address === 'string') return true; // unix socket
  return isLoopbackAddress(address.address);
}

/**
 * Decide whether to block a request. Returns a GuardBlock (status +
 * message) to reject, or null to allow. Applies only when shouldGuard()
 * is true — the caller gates on that.
 */
export function guardRequest(req: IncomingMessage): GuardBlock | null {
  // Host allow-list (anti DNS-rebinding). A missing Host cannot come from
  // a browser rebinding attack, so it passes (non-browser clients).
  const host = req.headers.host;
  if (host !== undefined) {
    const hostname = hostnameOf(host);
    if (hostname === null || !isLoopbackHostname(hostname)) {
      return { status: 421, message: 'Host not allowed (loopback only)' };
    }
  }

  const method = req.method ?? 'GET';
  const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (!mutating) return null;

  // CSRF: reject cross-site state-changing requests. Sec-Fetch-Site is set
  // by modern browsers; `same-origin`/`none` are safe, anything else is a
  // cross-context request.
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { status: 403, message: 'Cross-site request blocked' };
  }

  // A present Origin must be loopback. Same-origin browser requests send
  // the daemon's own (loopback) origin; a malicious page sends its own.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== '') {
    const originHost = originHostname(origin);
    if (originHost === null || !isLoopbackHostname(originHost)) {
      return { status: 403, message: 'Cross-origin request blocked' };
    }
  }

  return null;
}

/**
 * Extra guard for a route that answers with image bytes for a browser
 * `<img>` (see the module comment for why the global guard is not enough).
 * Returns a GuardBlock to reject, or null to allow. Never call it on a JSON
 * route: the SPA's `fetch()` sends `Sec-Fetch-Dest: empty`, which this
 * rejects.
 *
 * Both headers pass when absent, so `curl` and the Node client are
 * unaffected. That is safe: `Sec-Fetch-*` are forbidden header names, so a
 * browser always sets them and page script can never strip or forge them.
 */
export function guardImageSubresource(req: IncomingMessage): GuardBlock | null {
  // Same rule as the CSRF check: only a same-origin or browser-initiated
  // (`none`) context may ask.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return { status: 403, message: 'Cross-site request blocked' };
  }

  // The bytes are only ever meant for an <img>. A `document`, `iframe`,
  // `object`, `embed`, `script` or `style` destination is someone trying to
  // get the browser to interpret repo content, not display it.
  const dest = req.headers['sec-fetch-dest'];
  if (dest && dest !== 'image') {
    return { status: 403, message: 'Request destination must be an image' };
  }

  return null;
}

/**
 * Security response headers applied to every response from one choke point
 * (server.ts). Defense-in-depth for the served SPA — a strict CSP means a
 * future markup regression cannot execute injected script, and the frame
 * directives block clickjacking. The CSP fits the built web UI: external
 * hashed script + stylesheet, same-origin fetch/SSE, inline style
 * attributes from Vue :style bindings (hence style-src 'unsafe-inline').
 *
 * `Cross-Origin-Resource-Policy: same-origin` makes the browser drop any
 * response another origin embedded — the second half of the image-oracle
 * defense described in the module comment. It costs nothing here: nothing
 * outside the daemon's own origin is ever meant to embed a daemon response.
 *
 * The `'none'` directives are all "we never do this": the UI has no iframe,
 * no <audio>/<video>, no worker, and no form. Spelling them out means a
 * regression that adds one fails loudly instead of silently widening the
 * attack surface. `img-src` stays `'self' data:` — it must NOT gain `blob:`,
 * because repo image bytes are shown from a same-origin URL, and allowing
 * blob: would let injected script build an image src the CSP cannot vet.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};
