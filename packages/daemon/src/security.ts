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
 * The guard runs ONLY when the daemon is bound to a loopback address (the
 * default and only safe posture). When an operator deliberately binds a
 * routable interface (`--host`), they have left this threat model and get
 * a loud warning instead (index.ts); we cannot know the valid host names
 * there, so the guard would only produce false rejections.
 *
 * Non-browser clients (the CLI over @diffstalker/client, `curl`) send no
 * `Origin`/`Sec-Fetch-Site` and a loopback `Host`, so they pass untouched.
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

/** A loopback hostname: localhost, any 127.x, ::1, or a *.localhost name. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('127.')
  );
}

/** A loopback bind address, as reported by server.address(). */
export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.');
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
 * Security response headers applied to every response from one choke point
 * (server.ts). Defense-in-depth for the served SPA — a strict CSP means a
 * future markup regression cannot execute injected script, and the frame
 * directives block clickjacking. The CSP fits the built web UI: external
 * hashed script + stylesheet, same-origin fetch/SSE, inline style
 * attributes from Vue :style bindings (hence style-src 'unsafe-inline').
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};
