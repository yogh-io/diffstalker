/**
 * Journal wire tests: journal() request formation + response parse, and
 * the journal-append SSE round-trip, against a hand-rolled node:http
 * server on a /tmp unix socket serving the quoted wire contract
 * (GET /repos/:id/journal -> {epoch, prunedBefore, entries}; SSE
 * `journal-append` -> {epoch, entries}). Entries are JSON-native — the embedded
 * DiffResult must cross the wire byte-identical, like GET /diff.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiffstalkerClient } from './index.js';
import type {
  DiffResult,
  JournalAppendEvent,
  JournalBoundaryEntry,
  JournalHunkEntry,
  JournalResponse,
} from './index.js';

let seq = 0;
let server: http.Server | null = null;
let socketFile: string | null = null;

/** One-hunk snapshot diff as the daemon embeds it (file header + one @@ section). */
const hunkDiff: DiffResult = {
  raw: 'diff --git a/file.txt b/file.txt\n@@ -1,2 +1,3 @@\n context\n+added line\n',
  lines: [
    { type: 'header', content: 'diff --git a/file.txt b/file.txt' },
    { type: 'hunk', content: '@@ -1,2 +1,3 @@' },
    { type: 'context', content: ' context', oldLineNum: 1, newLineNum: 1 },
    { type: 'addition', content: '+added line', newLineNum: 2 },
  ],
};

// Typed against core's journal types: a shape drift fails compilation here.
const editedEntry: JournalHunkEntry = {
  type: 'hunk',
  seq: 7,
  ts: 1750000000000,
  path: 'file.txt',
  status: 'modified',
  kind: 'edited',
  span: { start: 1, count: 2 },
  stats: { insertions: 1, deletions: 0 },
  diff: hunkDiff,
  supersedes: [3],
  siblings: 1,
  seeded: false,
};

const revertedEntry: JournalHunkEntry = {
  type: 'hunk',
  seq: 9,
  ts: 1750000002000,
  path: 'other.txt',
  status: 'modified',
  kind: 'reverted',
  span: { start: 10, count: 5 },
  stats: { insertions: 0, deletions: 0 },
  diff: null,
  supersedes: [4, 5],
  siblings: 1,
  seeded: false,
};

const boundaryEntry: JournalBoundaryEntry = {
  type: 'boundary',
  seq: 8,
  ts: 1750000001000,
  kind: 'commit',
  label: 'a1b2c3d second commit',
  resolves: [7],
};

/** Start a server on a fresh unix socket; returns a client aimed at it. */
function startServer(
  handler: http.RequestListener
): Promise<{ client: DiffstalkerClient }> {
  const socketPath = path.join(os.tmpdir(), `ds-journal-test-${process.pid}-${seq++}.sock`);
  const srv = http.createServer(handler);
  server = srv;
  socketFile = socketPath;
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(socketPath, () => resolve({ client: new DiffstalkerClient({ socketPath }) }));
  });
}

afterEach(async () => {
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

describe('journal()', () => {
  test('hits GET /repos/:id/journal?since= and parses the envelope as-is', async () => {
    const urls: string[] = [];
    const response: JournalResponse = {
      epoch: 'mcw2a1b4-9f3ac2d1',
      prunedBefore: 0,
      entries: [editedEntry, boundaryEntry, revertedEntry],
    };
    const { client } = await startServer((req, res) => {
      urls.push(req.url ?? '');
      expect(req.method).toBe('GET');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });

    const result = await client.journal('r1', 42);
    expect(urls).toEqual(['/repos/r1/journal?since=42']);
    // The payload is JSON-native: everything survives the wire unchanged.
    expect(result).toEqual(response);
    // The embedded DiffResult is intact — same decode as GET /diff.
    const hunk = result.entries[0] as JournalHunkEntry;
    expect(hunk.diff).toEqual(hunkDiff);
    // The tombstone's null diff and plural supersedes survive.
    const tombstone = result.entries[2] as JournalHunkEntry;
    expect(tombstone.diff).toBeNull();
    expect(tombstone.supersedes).toEqual([4, 5]);
  });

  test('omits the since parameter when not given', async () => {
    const urls: string[] = [];
    const { client } = await startServer((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ epoch: 'e1', prunedBefore: 0, entries: [] }));
    });

    const result = await client.journal('r1');
    expect(urls).toEqual(['/repos/r1/journal']);
    expect(result.entries).toEqual([]);
  });

  test('since=0 is sent explicitly (0 is a valid seq floor, not "omitted")', async () => {
    const urls: string[] = [];
    const { client } = await startServer((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ epoch: 'e1', prunedBefore: 0, entries: [] }));
    });

    await client.journal('r1', 0);
    expect(urls).toEqual(['/repos/r1/journal?since=0']);
  });
});

describe('journal-append SSE', () => {
  test('one observation batch round-trips through subscribeRepo', async () => {
    const batch: JournalAppendEvent = { epoch: 'e1', entries: [editedEntry, revertedEntry] };
    const { client } = await startServer((req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: journal-append\ndata: ${JSON.stringify(batch)}\n\n`);
    });

    const subscription = client.subscribeRepo('r1');
    try {
      const received = await new Promise<JournalAppendEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for journal-append')),
          5000
        );
        subscription.on('journal-append', (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
        subscription.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      // Atomic batch, entries byte-faithful including the embedded diff.
      expect(received).toEqual(batch);
      expect((received.entries[0] as JournalHunkEntry).diff).toEqual(hunkDiff);
      expect((received.entries[1] as JournalHunkEntry).diff).toBeNull();
    } finally {
      subscription.close();
    }
  });
});
