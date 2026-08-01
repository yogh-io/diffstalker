/* eslint-disable sonarjs/no-hardcoded-ip -- test fixtures use example IPs to
   exercise the loopback vs routable distinction. */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sniffImage } from '@diffstalker/core/utils/imageSniff';
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
    for (const h of [
      'localhost',
      '127.0.0.1',
      '127.1.2.3',
      '127.0.0.0',
      '127.255.255.255',
      '::1',
      'diffstalker.localhost',
    ]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });
  test('rejects routable / attacker hosts', () => {
    for (const h of ['evil.com', 'example.org', '10.0.0.5', '0.0.0.0', 'localhost.evil.com']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
  test('rejects a public domain that merely STARTS with a loopback ip', () => {
    // The whole DNS-rebinding defense: 127.0.0.1.evil.com is registrable, and a
    // prefix match on '127.' would make an attacker page same-origin.
    for (const h of ['127.0.0.1.evil.com', '127.evil.com', '127.0.0.1.', '127.0.0.1x']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
  test('rejects malformed octets', () => {
    for (const h of ['1270.0.0.1', '127.0.0.256', '127.0.0', '127.0.0.1.1', '127..0.1', '127']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
  test('rejects a bare .localhost and a name outside that TLD', () => {
    expect(isLoopbackHostname('.localhost')).toBe(false);
    expect(isLoopbackHostname('mylocalhost')).toBe(false);
    expect(isLoopbackHostname('localhost.attacker.tld')).toBe(false);
  });
  test('rejects an IPv6 loopback spelling the URL parser does not canonicalize', () => {
    // ::ffff:127.0.0.1 normalizes to ::ffff:7f00:1, not ::1. Failing closed on
    // it is deliberate — nothing reaches the daemon under that name.
    expect(isLoopbackHostname('::ffff:7f00:1')).toBe(false);
    expect(isLoopbackHostname('::2')).toBe(false);
  });
});

describe('isLoopbackAddress / shouldGuard', () => {
  test('loopback TCP binds are guarded', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.255.255.255')).toBe(true);
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
  test('blocks a public domain prefixed with a loopback ip', () => {
    // The rebinding hole a '127.' prefix match leaves open: this name is
    // registrable, resolves wherever the attacker points it, and would
    // otherwise be same-origin with the daemon.
    expect(guardRequest(req('GET', { host: '127.0.0.1.evil.com:7337' }))?.status).toBe(421);
    expect(guardRequest(req('GET', { host: '127.0.0.1x:7337' }))?.status).toBe(421);
    expect(guardRequest(req('GET', { host: '1270.0.0.1:7337' }))?.status).toBe(421);
    expect(guardRequest(req('GET', { host: '127.0.0.256:7337' }))?.status).toBe(421);
  });
  test('allows loopback ip spellings the URL parser canonicalizes', () => {
    // The Host header is normalized before the allow-list sees it, so these
    // reach the same '127.0.0.1' / '::1' the exact match expects.
    expect(guardRequest(req('GET', { host: '127.1:7337' }))).toBeNull();
    expect(guardRequest(req('GET', { host: '2130706433:7337' }))).toBeNull();
    expect(guardRequest(req('GET', { host: '[0:0:0:0:0:0:0:1]:7337' }))).toBeNull();
  });
  test('blocks a mutation whose Origin only prefixes a loopback ip', () => {
    const blocked = guardRequest(
      // The scheme is irrelevant to the check; https matches the neighbouring
      // cross-origin tests and keeps the clear-text-protocol lint quiet.
      req('POST', { host: '127.0.0.1:7337', origin: 'https://127.0.0.1.evil.com' })
    );
    expect(blocked?.status).toBe(403);
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

/**
 * The complete list of content types repo bytes can ever be served as.
 *
 * A repo blob's content-type is whatever `sniffImage` returns for the exact
 * buffer about to be written — `blobHeaders` copies `info.mime` verbatim and
 * has nothing else to offer — so this table IS the policy. It lives next to
 * the other security assertions because widening it is a security decision,
 * not a table edit: `staticFiles.ts` maps `.svg`, `.html` and `.wasm` for the
 * SPA's own assets, and every one of those would be same-origin code if it
 * ever reached repo content.
 */
describe('repo-blob content types', () => {
  function bytes(...values: number[]): Uint8Array {
    return Uint8Array.from(values);
  }

  function text(value: string): Uint8Array {
    return Uint8Array.from(value, (c) => c.charCodeAt(0));
  }

  function join(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  function u32be(value: number): Uint8Array {
    return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  function pngChunk(type: string, data: Uint8Array): Uint8Array {
    return join(u32be(data.length), text(type), data, bytes(0, 0, 0, 0));
  }

  /** 1x1 truecolour+alpha PNG header, then the chunk that ends the metadata. */
  const PNG = join(
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', join(u32be(1), u32be(1), bytes(8, 6, 0, 0, 0))),
    pngChunk('IDAT', bytes(0x78, 0x9c, 0x63, 0x00))
  );

  /** SOI, a JFIF APP0, then a baseline SOF0 carrying 1x1. */
  const JPEG = join(
    bytes(0xff, 0xd8),
    bytes(0xff, 0xe0, 0x00, 0x10),
    join(text('JFIF'), bytes(0, 1, 1, 0, 0, 1, 0, 1, 0, 0)),
    bytes(0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0),
    bytes(0xff, 0xd9)
  );

  /** The canonical 1x1 GIF every encoder emits. */
  const GIF = Uint8Array.from(
    Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  );

  const ALLOWED: Array<[string, Uint8Array, string]> = [
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['gif', GIF, 'image/gif'],
  ];

  /**
   * One sample per family the VETO list names, by the magic a browser would
   * type it from. SVG, HTML and XML have no magic at all, which is exactly why
   * they must never be typed from a name.
   */
  const REFUSED: Array<[string, Uint8Array]> = [
    ['svg', text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['html', text('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')],
    ['xml', text('<?xml version="1.0"?><root><a/></root>')],
    ['pdf', text('%PDF-1.7\n1 0 obj\n<< /OpenAction << /S /JavaScript >> >>\n')],
    ['woff2', text('wOF2\0\0\0\0')],
    ['ttf', bytes(0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0)],
    ['wasm', bytes(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)],
    ['mp4', join(u32be(24), text('ftypisom'), new Uint8Array(12))],
    ['webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00)],
    ['webp', join(text('RIFF'), u32be(24), text('WEBPVP8 '), new Uint8Array(8))],
  ];

  function mimeFor(sample: Uint8Array): string | null {
    const result = sniffImage(sample, sample.length, true);
    return result.ok ? result.info.mime : null;
  }

  test('the table has exactly three entries, all of them images', () => {
    const served = ALLOWED.map(([, sample]) => mimeFor(sample));
    expect(served).toEqual(ALLOWED.map(([, , mime]) => mime));
    expect(new Set(served).size).toBe(3);
  });

  test('no svg, html, xml, pdf, font, wasm or video entry exists', () => {
    const served = new Set(ALLOWED.map(([, sample]) => mimeFor(sample)));
    for (const forbidden of [
      'image/svg+xml',
      'text/html',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'application/pdf',
      'font/woff2',
      'font/ttf',
      'application/font-woff',
      'application/wasm',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'image/webp',
      'application/octet-stream',
    ]) {
      expect(served).not.toContain(forbidden);
    }
  });

  test('every refused family sniffs to nothing, so it has no type to serve', () => {
    for (const [label, sample] of REFUSED) {
      expect([label, mimeFor(sample)]).toEqual([label, null]);
    }
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

  test('a rebinding Host prefixed with a loopback ip is refused over the wire', async () => {
    // Same-origin from http://127.0.0.1.evil.com would defeat every read
    // control at once, so pin it at the socket, not just at the predicate.
    const res = await fetch(`${baseUrl}/health`, { headers: { host: '127.0.0.1.evil.com' } });
    expect(res.status).toBe(421);
  });
});
