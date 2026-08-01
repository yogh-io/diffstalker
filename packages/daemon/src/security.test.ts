/* eslint-disable sonarjs/no-hardcoded-ip -- test fixtures use example IPs to
   exercise the loopback vs routable distinction. */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isLoopbackHostname,
  isLoopbackAddress,
  shouldGuard,
  guardRequest,
  guardImageSubresource,
  SECURITY_HEADERS,
} from './security.js';
import { createDaemon, Daemon } from './server.js';

/** Minimal IncomingMessage stand-in: method + headers is all guardRequest reads. */
function req(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

describe('isLoopbackHostname', () => {
  test('accepts loopback names and addresses', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', 'diffstalker.localhost']) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });
  test('rejects routable / attacker hosts', () => {
    for (const h of ['evil.com', 'example.org', '10.0.0.5', '0.0.0.0', 'localhost.evil.com']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

describe('isLoopbackAddress / shouldGuard', () => {
  test('loopback TCP binds are guarded', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(shouldGuard({ address: '127.0.0.1', family: 'IPv4', port: 7337 })).toBe(true);
  });
  test('a unix socket (string address) is guarded', () => {
    expect(shouldGuard('/run/diffstalker/diffstalkerd.sock')).toBe(true);
  });
  test('a routable / wildcard bind is NOT guarded (operator-exposed)', () => {
    expect(shouldGuard({ address: '0.0.0.0', family: 'IPv4', port: 7337 })).toBe(false);
    expect(shouldGuard({ address: '10.0.0.5', family: 'IPv4', port: 7337 })).toBe(false);
    expect(shouldGuard(null)).toBe(false);
  });
});

describe('guardRequest — Host allow-list (DNS rebinding)', () => {
  test('allows loopback Host with a port', () => {
    expect(guardRequest(req('GET', { host: '127.0.0.1:7337' }))).toBeNull();
    expect(guardRequest(req('GET', { host: 'localhost:7337' }))).toBeNull();
    expect(guardRequest(req('GET', { host: 'diffstalker.localhost:7337' }))).toBeNull();
    expect(guardRequest(req('GET', { host: '[::1]:7337' }))).toBeNull();
  });
  test('allows a missing Host (non-browser client)', () => {
    expect(guardRequest(req('GET', {}))).toBeNull();
  });
  test('blocks a rebound attacker Host with 421', () => {
    const blocked = guardRequest(req('GET', { host: 'evil.com' }));
    expect(blocked?.status).toBe(421);
  });
  test('blocks a Host that merely embeds localhost', () => {
    expect(guardRequest(req('GET', { host: 'localhost.evil.com' }))?.status).toBe(421);
  });
});

describe('guardRequest — CSRF on mutations', () => {
  test('allows a same-origin loopback mutation', () => {
    expect(
      guardRequest(
        req('POST', {
          host: 'localhost:7337',
          origin: 'http://localhost:7337',
          'sec-fetch-site': 'same-origin',
        })
      )
    ).toBeNull();
  });
  test('allows a mutation with no Origin (curl / CLI client)', () => {
    expect(guardRequest(req('POST', { host: '127.0.0.1:7337' }))).toBeNull();
  });
  test('blocks a cross-site Sec-Fetch-Site with 403', () => {
    const blocked = guardRequest(
      req('POST', { host: '127.0.0.1:7337', 'sec-fetch-site': 'cross-site' })
    );
    expect(blocked?.status).toBe(403);
  });
  test('blocks a cross-origin Origin with 403', () => {
    const blocked = guardRequest(
      req('POST', { host: '127.0.0.1:7337', origin: 'https://evil.com' })
    );
    expect(blocked?.status).toBe(403);
  });
  test('blocks the null origin (sandboxed iframe)', () => {
    expect(
      guardRequest(req('POST', { host: '127.0.0.1:7337', origin: 'null' }))?.status
    ).toBe(403);
  });
  test('GET reads are not subject to the CSRF (Origin) check', () => {
    // A cross-origin GET carries an Origin but cannot read the response
    // (no CORS) — the Host allow-list is the relevant defense, not Origin.
    expect(
      guardRequest(req('GET', { host: '127.0.0.1:7337', origin: 'https://evil.com' }))
    ).toBeNull();
  });
});

describe('guardImageSubresource', () => {
  test('allows a request with no Sec-Fetch-* headers (curl / Node client)', () => {
    expect(guardImageSubresource(req('GET', { host: '127.0.0.1:7337' }))).toBeNull();
  });
  test('allows the browser <img> case: same-origin + image', () => {
    expect(
      guardImageSubresource(
        req('GET', {
          host: '127.0.0.1:7337',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-dest': 'image',
        })
      )
    ).toBeNull();
  });
  test('allows sec-fetch-site: none (user typed the URL) with an image dest', () => {
    expect(
      guardImageSubresource(
        req('GET', { host: '127.0.0.1:7337', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'image' })
      )
    ).toBeNull();
  });
  test('blocks a cross-site or same-site embed with 403', () => {
    for (const site of ['cross-site', 'same-site']) {
      const blocked = guardImageSubresource(
        req('GET', { host: '127.0.0.1:7337', 'sec-fetch-site': site, 'sec-fetch-dest': 'image' })
      );
      expect(blocked?.status).toBe(403);
    }
  });
  test('blocks every non-image destination with 403', () => {
    for (const dest of ['document', 'iframe', 'object', 'embed', 'script', 'style', 'empty']) {
      const blocked = guardImageSubresource(
        req('GET', {
          host: '127.0.0.1:7337',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-dest': dest,
        })
      );
      expect(blocked?.status).toBe(403);
    }
  });
  test('rejects the SPA fetch destination — proof it must stay off JSON routes', () => {
    // The web UI's own fetch() sends `empty`. This is why the predicate is
    // separate from guardRequest and only ever runs on the bytes route.
    expect(
      guardImageSubresource(
        req('GET', {
          host: '127.0.0.1:7337',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-dest': 'empty',
        })
      )?.status
    ).toBe(403);
  });
});

describe('SECURITY_HEADERS', () => {
  test('includes the hardening headers and a CSP that fits the built SPA', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
  test('carries Cross-Origin-Resource-Policy (no cross-origin embedding)', () => {
    expect(SECURITY_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });
  test('the CSP spells out every capability the UI does not use', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    for (const directive of [
      "frame-src 'none'",
      "child-src 'none'",
      "media-src 'none'",
      "worker-src 'none'",
      "form-action 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
  test('img-src allows self and data: only — never blob:', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toContain('blob:');
  });
});

describe('security headers over the wire', () => {
  let daemon: Daemon;
  let baseUrl: string;

  beforeAll(async () => {
    // No followFile: follow mode disabled, no watcher (test convention).
    daemon = createDaemon({});
    await daemon.listen({ port: 0 });
    baseUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await daemon.close();
  });

  test('every response carries the headers, whatever the outcome', async () => {
    // The choke point in server.ts runs before routing AND before the origin
    // guard, so a 200, a 404 and a guard block are all covered.
    const responses = [
      await fetch(`${baseUrl}/health`),
      await fetch(`${baseUrl}/no/such/route`),
      await fetch(`${baseUrl}/health`, { headers: { host: 'evil.com' } }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 404, 421]);
    for (const res of responses) {
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("frame-src 'none'");
    }
  });
});
