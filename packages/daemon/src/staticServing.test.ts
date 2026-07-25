/**
 * Static-file serving (the bundled web UI): real HTTP requests against a
 * daemon bound to an ephemeral TCP port, with --web-root pointed at a temp
 * fixture dir. Asserts the SPA is served, the API is never shadowed, and
 * path traversal cannot escape the web root.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDaemon, Daemon } from './server.js';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../test-fixtures');
const WEB_ROOT = path.join(FIXTURES_DIR, 'web-root');

const INDEX_HTML =
  '<!doctype html><html><head><title>diffstalker</title></head>' +
  '<body><div id="app">web-root-fixture</div></body></html>';
const APP_JS = 'console.log("fixture asset");';

let daemon: Daemon;
let baseUrl: string;

beforeAll(async () => {
  fs.rmSync(WEB_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WEB_ROOT, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(WEB_ROOT, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(WEB_ROOT, 'assets', 'app.js'), APP_JS);

  // No followFile: follow mode disabled, no watcher (test convention).
  daemon = createDaemon({ webRoot: WEB_ROOT });
  await daemon.listen({ port: 0 });
  const address = daemon.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(WEB_ROOT, { recursive: true, force: true });
});

describe('daemon static serving (web UI)', () => {
  test('GET / serves index.html as text/html, no-cache', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test('GET on an unknown non-API path serves index.html (SPA fallback)', async () => {
    const res = await fetch(`${baseUrl}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test('GET /assets/app.js serves the file with a JS content type, immutable cache', async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(APP_JS);
  });

  test('GET /health still answers JSON: the API is not shadowed', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toMatchObject({ ok: true, ready: true });
  });

  test('unknown paths under API prefixes stay JSON 404s, not SPA fallbacks', async () => {
    const res = await fetch(`${baseUrl}/repos/nope/bogus`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test('encoded path traversal cannot escape the web root (403)', async () => {
    // %2e%2e as a whole segment is normalized away by URL parsing, so the
    // live vector is the encoded slash: ..%2f stays one opaque segment
    // until the server decodes it. Containment must catch it.
    const res = await fetch(`${baseUrl}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Forbidden');
  });

  test('traversal inside a real prefix is contained too', async () => {
    const res = await fetch(`${baseUrl}/assets/..%2f..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
  });

  test('a raw literal /../ path (no client normalization) cannot escape', async () => {
    // Bypass fetch's client-side dot-segment normalization: write the
    // request line raw. The router's own URL parse normalizes it to
    // /etc/passwd, which is inside the root and not a file -> SPA
    // fallback, never the real /etc/passwd.
    const address = daemon.address() as AddressInfo;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(address.port, '127.0.0.1', () => {
        socket.write('GET /../../../etc/passwd HTTP/1.1\r\nHost: localhost\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf-8');
        if (data.includes('</html>') || data.includes('\r\n\r\n{')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 3000);
    });
    expect(raw).toContain('200');
    expect(raw).toContain('web-root-fixture');
    expect(raw).not.toContain('root:');
  });

  test('non-GET methods never hit the static handler (JSON 404)', async () => {
    const res = await fetch(`${baseUrl}/some/spa/route`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('without a webRoot the daemon serves the API only: GET / is a JSON 404', async () => {
    const apiOnly = createDaemon();
    await apiOnly.listen({ port: 0 });
    try {
      const address = apiOnly.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/json');

      const health = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await apiOnly.close();
    }
  });
});
