/**
 * Router body handling over a real unix socket: invalid JSON, missing
 * required fields, and the 1MB body cap. Plus `sendBytes` against a stub
 * response — it needs no route and no socket, and the routes that write
 * bytes cover it end to end.
 *
 * Self-contained: own daemon instance, own socket, no repo fixtures and no
 * dependence on other test files' ordering.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { sendBytes } from './router.js';
import { createDaemon, Daemon } from './server.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-router-${process.pid}.sock`);
const NODE_SOCKET = path.join(os.tmpdir(), `diffstalkerd-router-node-${process.pid}.sock`);
const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');

let daemon: Daemon;

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

/**
 * Send a raw HTTP/1.1 request over a unix socket and return everything
 * the server sent back. Used for the oversized-body case: the server
 * responds 413 mid-upload and then drops the connection, which fetch
 * implementations surface inconsistently; a raw socket sees the actual
 * bytes.
 */
function rawRequest(socketPath: string, head: string, body: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const received: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(received).toString('utf-8'));
    };
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('close', finish);
    socket.on('error', (err) => {
      // EPIPE/ECONNRESET while still uploading is expected once the server
      // has answered early; the response bytes already received count.
      if (received.length === 0 && !settled) {
        settled = true;
        reject(err);
      } else {
        finish();
      }
    });
    socket.on('connect', () => {
      socket.write(head);
      socket.write(body);
    });
  });
}

beforeAll(async () => {
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
});

describe('router body handling', () => {
  test('invalid JSON body is a 400', async () => {
    const res = await request('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid JSON body');
  });

  test('missing required "path" field on POST /repos is a 400', async () => {
    const res = await request('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"path"');
  });

  test('non-object JSON body on POST /repos is a 400', async () => {
    const res = await request('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify('just a string'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"path"');
  });

  test('empty body on POST /repos is a 400 (undefined body, not a parse error)', async () => {
    const res = await request('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"path"');
  });

  // Known bun divergence: bun's node:http emulation mishandles a response
  // sent while the request body is still uploading — the raw bytes that
  // reach the client are mangled, and on the Expect: 100-continue path
  // (what curl uses for large bodies) bun even reports a bare 200 OK
  // instead of the router's 413. Under node the daemon answers a proper
  // 413, so this test asserts the node path: it spawns the daemon with
  // node from the compiled dist (tsc -b first, incremental).
  test(
    'body over 1MB is a 413 (daemon under node)',
    async () => {
      const build = spawnSync(path.join(PACKAGE_DIR, 'node_modules/.bin/tsc'), ['-b'], {
        cwd: PACKAGE_DIR,
        encoding: 'utf-8',
        timeout: 60000,
      });
      expect(build.status).toBe(0);

      const child = spawn('node', [path.join(PACKAGE_DIR, 'dist/index.js'), '--socket', NODE_SOCKET], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      try {
        const deadline = Date.now() + 10000;
        while (!stderr.includes('listening') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(stderr).toContain('listening on unix socket');

        const oversized = Buffer.alloc(1024 * 1024 + 1, 'a');
        const head =
          'POST /repos HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${oversized.length}\r\n` +
          'Connection: close\r\n' +
          '\r\n';
        const response = await rawRequest(NODE_SOCKET, head, oversized);
        expect(response).toStartWith('HTTP/1.1 413');
        expect(response).toContain('Request body too large');
      } finally {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exited;
        fs.rmSync(NODE_SOCKET, { force: true });
      }
    },
    90000
  );
});

interface StubResponse {
  status: number | null;
  headers: Record<string, string> | null;
  body: Uint8Array | null;
}

function stubResponse(): { res: ServerResponse; sent: StubResponse } {
  const sent: StubResponse = { status: null, headers: null, body: null };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return this;
    },
    end(chunk: Uint8Array) {
      sent.body = chunk;
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

describe('sendBytes', () => {
  test('writes the body unchanged with a content-length taken from it', () => {
    const { res, sent } = stubResponse();
    // Bytes a string round-trip would corrupt: a NUL and a lone 0xFF.
    const body = new Uint8Array([0x89, 0x50, 0x00, 0xff]);

    sendBytes(res, 200, body, { 'content-type': 'image/png' });

    expect(sent.status).toBe(200);
    expect(sent.headers).toEqual({ 'content-type': 'image/png', 'content-length': '4' });
    expect(sent.body).toBeInstanceOf(Uint8Array);
    expect([...(sent.body as Uint8Array)]).toEqual([0x89, 0x50, 0x00, 0xff]);
  });

  test('content-length wins over a caller-supplied one', () => {
    const { res, sent } = stubResponse();

    sendBytes(res, 200, new Uint8Array(3), { 'content-length': '9999' });

    expect(sent.headers?.['content-length']).toBe('3');
  });

  test('content-length is the view length, not the backing buffer length', () => {
    const { res, sent } = stubResponse();
    const view = new Uint8Array(new ArrayBuffer(64), 8, 5);

    sendBytes(res, 200, view, {});

    expect(sent.headers?.['content-length']).toBe('5');
  });

  test('sets no content-type of its own — the caller owns it', () => {
    const { res, sent } = stubResponse();

    sendBytes(res, 200, new Uint8Array(1), { 'cache-control': 'no-store' });

    expect(sent.headers).toEqual({ 'cache-control': 'no-store', 'content-length': '1' });
  });
});
