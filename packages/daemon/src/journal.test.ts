/**
 * Journal wire tests over a real unix socket: the since/epoch/prunedBefore
 * response shape of GET /repos/:id/journal, the journal-append SSE event,
 * and the store surviving a close + reopen (the browser-F5 case), plus
 * unit tests for the registry's LRU store cache.
 *
 * Self-contained: own daemon instance, own socket, own fixture repos under
 * /tmp (mkdtemp). Follow mode is disabled (createDaemon without a
 * followFile creates no hook-file watcher).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { JournalStoreCache } from './repoRegistry.js';
import { SseReader } from './test-helpers.js';

/** The diff text of a wire diff — the wire carries lines only. */
function wireDiffText(diff: { lines: { content: string }[] }): string {
  return diff.lines.map((l) => l.content).join('\n') + '\n';
}



const SOCKET = path.join(os.tmpdir(), `diffstalkerd-journal-${process.pid}.sock`);

let daemon: Daemon;
let repoDir: string;
let repoId: string;
const tempDirs: string[] = [];

/** Loose wire shape: enough structure to assert the contract on. */
interface WireEntry {
  type: 'hunk' | 'boundary';
  seq: number;
  ts: number;
  kind: string;
  path?: string;
  status?: string;
  span?: { start: number; count: number };
  stats?: { insertions: number; deletions: number };
  diff?: { lines: { content: string }[]; lines: unknown[] } | null;
  supersedes?: number[];
  siblings?: number;
  seeded?: boolean;
  label?: string;
  resolves?: number[];
}

interface WireJournal {
  epoch: string;
  prunedBefore: number;
  entries: WireEntry[];
}

function gitExec(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** A fresh temp git repo with one committed file and one worktree edit. */
function makeRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  gitExec(dir, 'init --initial-branch=main');
  gitExec(dir, 'config user.email "test@test.com"');
  gitExec(dir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  gitExec(dir, 'add .');
  gitExec(dir, 'commit -m "initial"');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  return dir;
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { ...init, unix: SOCKET } as RequestInit);
}

async function openRepo(repoPath: string): Promise<string> {
  const res = await request('/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

async function getJournal(id: string, since?: number): Promise<WireJournal> {
  const query = since === undefined ? '' : `?since=${since}`;
  const res = await request(`/repos/${id}/journal${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as WireJournal;
}

/** Poll the journal until pred holds (the seeding observation is async). */
async function journalWhen(
  id: string,
  pred: (journal: WireJournal) => boolean,
  timeoutMs = 5000
): Promise<WireJournal> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const journal = await getJournal(id);
    if (pred(journal)) return journal;
    if (Date.now() > deadline) throw new Error('Timed out waiting for journal entries');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function lastSeqOf(journal: WireJournal): number {
  return journal.entries.length > 0 ? journal.entries[journal.entries.length - 1].seq : 0;
}

beforeAll(async () => {
  repoDir = makeRepo('diffstalkerd-journal-');
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
  repoId = await openRepo(repoDir);
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /repos/:id/journal', () => {
  test('serves epoch, prunedBefore, and seq-ordered JSON-native entries', async () => {
    // Seeding: a journal-start boundary plus one seeded hunk for the edit.
    const journal = await journalWhen(repoId, (j) => j.entries.length >= 2);

    expect(typeof journal.epoch).toBe('string');
    expect(journal.epoch.length).toBeGreaterThan(0);
    expect(journal.prunedBefore).toBe(0);

    const [first] = journal.entries;
    expect(first.type).toBe('boundary');
    expect(first.kind).toBe('journal-start');
    expect(first.seq).toBe(1);

    const hunk = journal.entries.find((e) => e.type === 'hunk' && e.path === 'a.txt');
    expect(hunk).toBeDefined();
    expect(hunk!.seeded).toBe(true);
    expect(hunk!.kind).toBe('created');
    expect(hunk!.supersedes).toEqual([]);
    expect(hunk!.siblings).toBe(1);
    expect(hunk!.stats!.insertions).toBe(1);
    expect(typeof hunk!.ts).toBe('number');
    // The embedded DiffResult crosses the wire like /diff responses.
    expect(hunk!.diff).not.toBeNull();
    expect(wireDiffText(hunk!.diff!)).toContain('+two');
    expect(Array.isArray(hunk!.diff!.lines)).toBe(true);

    const seqs = journal.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test('since=<seq> returns only entries with a higher seq', async () => {
    const full = await journalWhen(repoId, (j) => j.entries.length >= 2);
    const lastSeq = lastSeqOf(full);

    const caughtUp = await getJournal(repoId, lastSeq);
    expect(caughtUp.entries).toEqual([]);
    expect(caughtUp.epoch).toBe(full.epoch);
    expect(caughtUp.prunedBefore).toBe(full.prunedBefore);

    const afterFirst = await getJournal(repoId, 1);
    expect(afterFirst.entries.every((e) => e.seq > 1)).toBe(true);
    expect(afterFirst.entries.length).toBe(full.entries.length - 1);

    // since=0 is "everything", same as omitting it.
    const explicitZero = await getJournal(repoId, 0);
    expect(explicitZero.entries.length).toBe(full.entries.length);
  });

  test('rejects a malformed since', async () => {
    // '', '1e2', and '0x10' would all silently coerce through Number().
    for (const since of ['abc', '-1', '1.5', '', '1e2', '0x10']) {
      const res = await request(`/repos/${repoId}/journal?since=${since}`);
      expect(res.status).toBe(400);
    }
  });

  test('unknown repo id is a 404', async () => {
    const res = await request('/repos/nope/journal');
    expect(res.status).toBe(404);
  });
});

describe('journal-append SSE', () => {
  test('an append fans out on the per-repo events channel', async () => {
    const before = await journalWhen(repoId, (j) => j.entries.length >= 2);
    const seededSeq = before.entries.find((e) => e.type === 'hunk')!.seq;

    const res = await request(`/repos/${repoId}/events`);
    expect(res.status).toBe(200);
    const reader = new SseReader(res.body!);
    try {
      const snapshot = await reader.next(5000);
      expect(snapshot.event).toBe('snapshot');

      // Grow the tracked edit, then force a refresh through a mutation:
      // the observation classifies the changed hunk and appends.
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\ntwo\nthree\n');
      await request(`/repos/${repoId}/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.txt' }),
      });

      // Skip interleaved state-change events; the append must arrive.
      let event = await reader.next(5000);
      while (event.event !== 'journal-append') {
        event = await reader.next(5000);
      }

      const payload = JSON.parse(event.data) as { epoch: string; entries: WireEntry[] };
      // The store's epoch rides along on every append — the same epoch
      // the REST endpoint serves, so clients can spot a reset store.
      expect(typeof payload.epoch).toBe('string');
      expect(payload.epoch.length).toBeGreaterThan(0);
      expect(payload.epoch).toBe(before.epoch);
      expect(payload.entries.length).toBeGreaterThanOrEqual(1);
      const entry = payload.entries.find((e) => e.type === 'hunk' && e.path === 'a.txt');
      expect(entry).toBeDefined();
      expect(entry!.supersedes).toContain(seededSeq);
      expect(['edited', 'expanded', 'shrunk']).toContain(entry!.kind);

      // The streamed entry is also served by the REST catch-up path.
      const after = await getJournal(repoId, lastSeqOf(before));
      expect(after.entries.some((e) => e.seq === entry!.seq)).toBe(true);
    } finally {
      await reader.close();
    }
  });
});

describe('store survives close + reopen (browser F5)', () => {
  test('same epoch and entries after refcount hits zero, chronology continues', async () => {
    const dir = makeRepo('diffstalkerd-journal-f5-');
    const id = await openRepo(dir);
    const before = await journalWhen(id, (j) => j.entries.length >= 2);
    const seededSeq = before.entries.find((e) => e.type === 'hunk')!.seq;

    // F5: the only client releases the repo — manager disposed, store kept.
    const closed = await request(`/repos/${id}`, { method: 'DELETE' });
    expect(closed.status).toBe(200);
    const listed = (await (await request('/repos')).json()) as { id: string }[];
    expect(listed.some((r) => r.id === id)).toBe(false);

    // Reopen: the path-hashed id is stable and the store is re-injected.
    expect(await openRepo(dir)).toBe(id);
    const after = await journalWhen(id, (j) => j.entries.length >= before.entries.length);
    expect(after.epoch).toBe(before.epoch);
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);

    // New edits keep appending to the same chronology: the new entry
    // supersedes a seq recorded before the close.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo again\n');
    await request(`/repos/${id}/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a.txt' }),
    });
    const grown = await journalWhen(id, (j) => lastSeqOf(j) > lastSeqOf(before));
    expect(grown.epoch).toBe(before.epoch);
    const newest = grown.entries[grown.entries.length - 1];
    expect(newest.type).toBe('hunk');
    expect(newest.supersedes).toContain(seededSeq);

    await request(`/repos/${id}`, { method: 'DELETE' });
  });
});

describe('JournalStoreCache', () => {
  test('acquire returns the surviving store for a known id', () => {
    const cache = new JournalStoreCache(2);
    const store = cache.acquire('a');
    expect(cache.acquire('a')).toBe(store);
    expect(cache.size).toBe(1);
  });

  test('prune evicts least-recently-used stores beyond the cap', () => {
    const cache = new JournalStoreCache(2);
    cache.acquire('a');
    cache.acquire('b');
    cache.acquire('a'); // touch: b is now the least recently used
    cache.acquire('c');
    cache.prune(() => false);
    expect(cache.size).toBe(2);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  test('never evicts an open repo, even over the cap', () => {
    const cache = new JournalStoreCache(1);
    cache.acquire('a');
    cache.acquire('b');
    cache.prune((id) => id === 'a');
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  test('a fresh store is minted after eviction (new epoch)', () => {
    const cache = new JournalStoreCache(1);
    const first = cache.acquire('a');
    cache.acquire('b');
    cache.prune(() => false);
    expect(cache.has('a')).toBe(false);
    const second = cache.acquire('a');
    expect(second).not.toBe(first);
    expect(second.epoch).not.toBe(first.epoch);
  });
});
