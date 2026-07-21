/**
 * SSE frame parser tests: SseConnection against a raw node:http server
 * on a /tmp unix socket whose response the tests write by hand — a
 * frame split across two chunks, two frames coalesced into one chunk,
 * comment/ping blocks, and stream closes mid-buffer. Asserts onEvent
 * fires exactly once per logical frame and no callback ever fires
 * after close().
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SseConnection } from './transport.js';
import type { SseHandlers } from './transport.js';

let seq = 0;
let server: http.Server | null = null;
let socketFile: string | null = null;
let connection: SseConnection | null = null;

/** Everything the handlers were called with, in order. */
interface Recorded {
  events: Array<{ event: string; data: string }>;
  closes: number;
  errors: Error[];
}

function recordingHandlers(afterEvent?: () => void): { recorded: Recorded; handlers: SseHandlers } {
  const recorded: Recorded = { events: [], closes: 0, errors: [] };
  const handlers: SseHandlers = {
    onEvent: (event, data) => {
      recorded.events.push({ event, data });
      afterEvent?.();
    },
    onClose: () => {
      recorded.closes += 1;
    },
    onError: (err) => {
      recorded.errors.push(err);
    },
  };
  return { recorded, handlers };
}

/** Start an SSE endpoint whose live response the test writes chunks to. */
function startServer(): Promise<{ socketPath: string; response: Promise<http.ServerResponse> }> {
  const socketPath = path.join(os.tmpdir(), `ds-transport-test-${process.pid}-${seq++}.sock`);
  let arrived!: (res: http.ServerResponse) => void;
  const response = new Promise<http.ServerResponse>((resolve) => {
    arrived = resolve;
  });
  const srv = http.createServer((req, res) => {
    // close() destroys the client socket mid-stream; swallow the EPIPE.
    req.on('error', () => {});
    res.on('error', () => {});
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    arrived(res);
  });
  server = srv;
  socketFile = socketPath;
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(socketPath, () => resolve({ socketPath, response }));
  });
}

/** Open a connection to a fresh server and await the server-side response. */
async function connect(afterEvent?: () => void) {
  const { socketPath, response } = await startServer();
  const { recorded, handlers } = recordingHandlers(afterEvent);
  connection = new SseConnection({ socketPath }, '/repos/r1/events', handlers);
  const res = await response;
  return { recorded, res };
}

/** Give written bytes time to cross the socket and callbacks to run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

afterEach(async () => {
  connection?.close();
  connection = null;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (socketFile) {
    fs.rmSync(socketFile, { force: true });
    socketFile = null;
  }
});

describe('SSE frame parsing', () => {
  test('a frame split across two chunks fires exactly once, on completion', async () => {
    const { recorded, res } = await connect();

    res.write('event: state-change\ndata: {"n"');
    await settle();
    expect(recorded.events).toEqual([]);

    res.write(':1}\n\n');
    await settle();
    expect(recorded.events).toEqual([{ event: 'state-change', data: '{"n":1}' }]);
  });

  test('two frames in one chunk fire once each, in order', async () => {
    const { recorded, res } = await connect();

    res.write('event: snapshot\ndata: 1\n\nevent: state-change\ndata: 2\n\n');
    await settle();
    expect(recorded.events).toEqual([
      { event: 'snapshot', data: '1' },
      { event: 'state-change', data: '2' },
    ]);
  });

  test('comment/ping lines never fire the event callback', async () => {
    const { recorded, res } = await connect();

    // A comment-only block is a full frame with nothing in it.
    res.write(': ping\n\n');
    await settle();
    expect(recorded.events).toEqual([]);

    // A comment line inside a frame is skipped; the frame still fires.
    res.write('event: snapshot\n: ping\ndata: x\n\n');
    await settle();
    expect(recorded.events).toEqual([{ event: 'snapshot', data: 'x' }]);
  });

  test('stream end mid-buffer: the partial frame never fires; onClose fires once', async () => {
    const { recorded, res } = await connect();

    res.write('event: snapshot\ndata: incompl');
    await settle();
    res.end();
    await settle();

    expect(recorded.events).toEqual([]);
    expect(recorded.closes).toBe(1);
    expect(recorded.errors).toEqual([]);
  });

  test('close() silences everything: no callback fires afterwards', async () => {
    const { recorded, res } = await connect();

    res.write('event: snapshot\ndata: 1\n\n');
    await settle();
    expect(recorded.events).toHaveLength(1);

    connection!.close();
    res.write('event: state-change\ndata: 2\n\n');
    res.end();
    await settle();

    expect(recorded.events).toHaveLength(1);
    expect(recorded.closes).toBe(0);
    expect(recorded.errors).toEqual([]);
  });

  test('a handler closing mid-buffer drops the rest of the chunk', async () => {
    // The first event's handler closes the connection; the second frame
    // arrived in the SAME chunk and must not fire.
    const { recorded, res } = await connect(() => connection!.close());

    res.write('event: snapshot\ndata: 1\n\nevent: state-change\ndata: 2\n\n');
    await settle();

    expect(recorded.events).toEqual([{ event: 'snapshot', data: '1' }]);
    expect(recorded.closes).toBe(0);
    expect(recorded.errors).toEqual([]);
  });
});
