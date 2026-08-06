/**
 * POST /repos/:id/search over a real unix socket.
 *
 * The method itself is under test: this endpoint is a read, so GET is the
 * instinctive shape, and GET is exactly the shape that would sit outside the
 * daemon's CSRF guard and become a cross-site timing oracle. If someone
 * "corrects" it to a GET, the first test here fails.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'daemon-search';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-search-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;
let repoId: string;

interface WireGrepResult {
  matches: { path: string; line: number; text: string; truncated: boolean }[];
  capped: boolean;
  incomplete: boolean;
  binarySkipped: number;
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

function search(query: string): Promise<Response> {
  return request(`/repos/${repoId}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, '.gitignore', 'secret/\n');
  writeFixtureFile(repoPath, 'src/main.ts', 'const needle = 1;\nconst other = 2;\n');
  writeFixtureFile(repoPath, 'docs/guide.md', 'a needle in the docs\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');

  writeFixtureFile(repoPath, 'untracked.txt', 'needle in an untracked file\n');
  writeFixtureFile(repoPath, 'secret/hidden.txt', 'needle that must stay hidden\n');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });

  const res = await request('/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  });
  expect(res.status).toBe(201);
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('POST /repos/:id/search', () => {
  test('is NOT reachable as a GET — that would escape the CSRF guard', async () => {
    const res = await request(`/repos/${repoId}/search?query=needle`);
    expect(res.status).toBe(404);
  });

  test('finds matches across tracked and untracked files', async () => {
    const res = await search('needle');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireGrepResult;

    const paths = body.matches.map((m) => m.path).sort();
    expect(paths).toEqual(['docs/guide.md', 'src/main.ts', 'untracked.txt']);
    expect(body.capped).toBe(false);
    expect(body.incomplete).toBe(false);
  });

  test('never searches a gitignored file', async () => {
    const body = (await (await search('needle')).json()) as WireGrepResult;
    expect(body.matches.map((m) => m.path)).not.toContain('secret/hidden.txt');
  });

  test('reports path, 1-based line and the matched text', async () => {
    const body = (await (await search('const needle')).json()) as WireGrepResult;
    expect(body.matches.length).toBe(1);
    expect(body.matches[0]).toMatchObject({
      path: 'src/main.ts',
      line: 1,
      text: 'const needle = 1;',
      truncated: false,
    });
  });

  test('a query with no matches is an empty result, not an error', async () => {
    const res = await search('nothing-matches-this');
    expect(res.status).toBe(200);
    expect(((await res.json()) as WireGrepResult).matches).toEqual([]);
  });

  test('rejects a too-short query with 400', async () => {
    const res = await search('ne');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('at least');
  });

  test('rejects a missing query field with 400', async () => {
    const res = await request(`/repos/${repoId}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('404s an unknown repo id', async () => {
    const res = await request('/repos/deadbeefcafe/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'needle' }),
    });
    expect(res.status).toBe(404);
  });

  test('a leading dash in the query is data, not a git option', async () => {
    // If the query were argv-positional, git would read this as an option
    // and write the file. It goes through `-e`, so it is a literal string
    // that simply matches nothing.
    const canary = path.join(repoPath, 'canary.txt');
    const res = await search(`--output=${canary}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as WireGrepResult).matches).toEqual([]);
    expect(fs.existsSync(canary)).toBe(false);
  });
});
