/**
 * The PR draft routes over real unix sockets: read, save, conflict,
 * delete, "start from this", both API modes, and the branch names that
 * must never reach the filesystem. The gh runner is a fake that counts
 * its calls; none of these routes may run it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DRAFT_VERSION_ABSENT, MAX_DRAFT_BYTES, type PrDraft } from '@diffstalker/core/types/work';
import { createDaemon, type Daemon } from './server.js';
import type { GhRunner } from './github.js';
import { createFixtureRepo, gitExec, removeFixtureRepo, writeFixtureFile } from './test-helpers.js';

const FIXTURE = 'daemon-draft';
const LINKED = `${FIXTURE}-linked`;
const SOCKET = path.join(os.tmpdir(), `dsd-draft-${process.pid}.sock`);
const WEB_SOCKET = path.join(os.tmpdir(), `dsd-draft-web-${process.pid}.sock`);

let daemon: Daemon;
let webDaemon: Daemon;
let repoPath: string;
let linkedPath: string;
let commonDir: string;
let repoId: string;
let webRepoId: string;
let linkedId: string;
let ghCalls = 0;
let tmpDir: string;

const fakeGh: GhRunner = {
  available: () => true,
  run: () => {
    ghCalls++;
    return Promise.reject(new Error('no gh in this test'));
  },
};

function request(socket: string, pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { ...init, unix: socket } as RequestInit);
}

function send(socket: string, method: string, pathname: string, body: unknown): Promise<Response> {
  return request(socket, pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function openOn(socket: string, repo: string): Promise<string> {
  const res = await send(socket, 'POST', '/repos', { path: repo });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

const getDraft = (branch: string, id = repoId, socket = SOCKET) =>
  request(socket, `/repos/${id}/draft?branch=${encodeURIComponent(branch)}`);
const putDraft = (body: unknown, id = repoId, socket = SOCKET) =>
  send(socket, 'PUT', `/repos/${id}/draft`, body);
const adopt = (body: unknown, id = repoId, socket = SOCKET) =>
  send(socket, 'POST', `/repos/${id}/draft/adopt`, body);

function draftPath(branch: string, name: string): string {
  return path.join(commonDir, 'diffstalker', 'pr', ...branch.split('/'), name);
}

/** Every path under a directory, relative, sorted. */
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

beforeAll(async () => {
  removeFixtureRepo(LINKED);
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'file.txt', 'one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -q -m initial');
  linkedPath = path.join(repoPath, '..', LINKED);
  gitExec(repoPath, `worktree add -q -b linked-branch "${linkedPath}"`);
  commonDir = path.join(repoPath, '.git');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-draft-test-'));

  daemon = createDaemon({
    gh: fakeGh,
    workMarksFile: path.join(tmpDir, 'work.json'),
    updateCheck: false,
  });
  webDaemon = createDaemon({ apiMode: 'web', gh: fakeGh, updateCheck: false });
  await daemon.listen({ socketPath: SOCKET });
  await webDaemon.listen({ socketPath: WEB_SOCKET });
  repoId = await openOn(SOCKET, repoPath);
  linkedId = await openOn(SOCKET, linkedPath);
  webRepoId = await openOn(WEB_SOCKET, repoPath);
});

afterAll(async () => {
  await daemon.close();
  await webDaemon.close();
  removeFixtureRepo(FIXTURE);
  removeFixtureRepo(LINKED);
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(WEB_SOCKET, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the draft routes', () => {
  test('a branch with nothing on disk reads as all null', async () => {
    const res = await getDraft('nothing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      branch: 'nothing',
      top: null,
      suggested: null,
      ai: null,
      adoptedUnedited: false,
      version: DRAFT_VERSION_ABSENT,
    });
  });

  test('PUT then GET, and a stale version is a 409 that writes nothing', async () => {
    const first = await putDraft({
      branch: 'feature/x',
      top: 'Why.\n',
      version: DRAFT_VERSION_ABSENT,
    });
    expect(first.status).toBe(200);
    const saved = (await first.json()) as PrDraft;
    expect(saved.top).toBe('Why.\n');
    expect(saved.version).toBe(createHash('sha256').update('Why.\n').digest('hex'));
    expect(await (await getDraft('feature/x')).json()).toEqual(saved);
    expect(fs.readFileSync(draftPath('feature/x', 'top.md'), 'utf8')).toBe('Why.\n');

    const stale = await putDraft({
      branch: 'feature/x',
      top: 'other',
      version: DRAFT_VERSION_ABSENT,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe('Draft changed elsewhere');
    expect(fs.readFileSync(draftPath('feature/x', 'top.md'), 'utf8')).toBe('Why.\n');
  });

  test('an empty top deletes the draft', async () => {
    const saved = (await (
      await putDraft({ branch: 'gone', top: 'x', version: DRAFT_VERSION_ABSENT })
    ).json()) as PrDraft;
    const res = await putDraft({ branch: 'gone', top: '', version: saved.version });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PrDraft).top).toBeNull();
    expect(fs.existsSync(path.dirname(draftPath('gone', 'top.md')))).toBe(false);
  });

  test('start from this, and the agent files stay as they were', async () => {
    fs.mkdirSync(path.dirname(draftPath('adopt-me', 'x')), { recursive: true });
    fs.writeFileSync(draftPath('adopt-me', 'top.suggested.md'), 'Suggested. {{why?}}\n');
    fs.writeFileSync(draftPath('adopt-me', 'ai.md'), '<details>notes</details>\n');
    const old = new Date('2020-01-01T00:00:00Z');
    for (const name of ['top.suggested.md', 'ai.md'])
      fs.utimesSync(draftPath('adopt-me', name), old, old);

    const adopted = await adopt({ branch: 'adopt-me', version: DRAFT_VERSION_ABSENT });
    expect(adopted.status).toBe(200);
    const draft = (await adopted.json()) as PrDraft;
    expect(draft).toMatchObject({
      top: 'Suggested. {{why?}}\n',
      suggested: 'Suggested. {{why?}}\n',
      ai: '<details>notes</details>\n',
      adoptedUnedited: true,
    });

    const again = await adopt({ branch: 'adopt-me', version: draft.version });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('top.md is not empty');

    const edited = (await (
      await putDraft({ branch: 'adopt-me', top: 'Mine.', version: draft.version })
    ).json()) as PrDraft;
    expect(edited.adoptedUnedited).toBe(false);
    await putDraft({ branch: 'adopt-me', top: '', version: edited.version });

    for (const name of ['top.suggested.md', 'ai.md']) {
      expect(fs.statSync(draftPath('adopt-me', name)).mtimeMs).toBe(old.getTime());
    }
    expect(fs.readFileSync(draftPath('adopt-me', 'top.suggested.md'), 'utf8')).toBe(
      'Suggested. {{why?}}\n'
    );
    expect(fs.readFileSync(draftPath('adopt-me', 'ai.md'), 'utf8')).toBe(
      '<details>notes</details>\n'
    );

    const none = await adopt({ branch: 'no-suggestion', version: DRAFT_VERSION_ABSENT });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toBe('No suggestion to start from');
  });

  test('a draft file that is a link is a 422', async () => {
    fs.mkdirSync(path.dirname(draftPath('linked-file', 'x')), { recursive: true });
    fs.symlinkSync('/etc/hostname', draftPath('linked-file', 'ai.md'));
    const res = await getDraft('linked-file');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('ai.md is a symbolic link');
  });

  test('a save over an unreadable agent file is a 422 and writes nothing', async () => {
    fs.mkdirSync(path.dirname(draftPath('big-ai', 'x')), { recursive: true });
    fs.writeFileSync(draftPath('big-ai', 'ai.md'), 'x'.repeat(MAX_DRAFT_BYTES + 1));
    const res = await putDraft({ branch: 'big-ai', top: 'hello', version: DRAFT_VERSION_ABSENT });
    expect(res.status).toBe(422);
    expect(fs.existsSync(draftPath('big-ai', 'top.md'))).toBe(false);
  });

  test('a top over the size cap is a 413', async () => {
    const res = await putDraft({
      branch: 'big',
      top: 'x'.repeat(MAX_DRAFT_BYTES + 1),
      version: DRAFT_VERSION_ABSENT,
    });
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.dirname(draftPath('big', 'top.md')))).toBe(false);
  });

  test('bad bodies are 400s', async () => {
    expect((await putDraft({ branch: 'b', version: DRAFT_VERSION_ABSENT })).status).toBe(400);
    expect((await putDraft({ branch: 'b', top: 'x' })).status).toBe(400);
    expect((await putDraft({ top: 'x', version: DRAFT_VERSION_ABSENT })).status).toBe(400);
    expect((await adopt({ branch: 'b' })).status).toBe(400);
    expect((await request(SOCKET, `/repos/${repoId}/draft`)).status).toBe(400);
  });

  test('an unknown repo is a 404', async () => {
    expect((await getDraft('main', 'nope')).status).toBe(404);
  });

  test('a linked worktree writes into the common dir', async () => {
    const res = await putDraft(
      { branch: 'linked-branch', top: 'From the worktree', version: DRAFT_VERSION_ABSENT },
      linkedId
    );
    expect(res.status).toBe(200);
    expect(fs.readFileSync(draftPath('linked-branch', 'top.md'), 'utf8')).toBe('From the worktree');
    const perWorktree = path.join(commonDir, 'worktrees', LINKED);
    expect(fs.existsSync(path.join(perWorktree, 'diffstalker'))).toBe(false);
    // The main worktree reads the same draft.
    expect(((await (await getDraft('linked-branch')).json()) as PrDraft).top).toBe(
      'From the worktree'
    );
  });

  test('the web API mode routes all four', async () => {
    expect((await getDraft('web', webRepoId, WEB_SOCKET)).status).toBe(200);
    const put = await putDraft(
      { branch: 'web', top: 'w', version: DRAFT_VERSION_ABSENT },
      webRepoId,
      WEB_SOCKET
    );
    expect(put.status).toBe(200);
    const adoptRes = await adopt({ branch: 'web', version: 'x' }, webRepoId, WEB_SOCKET);
    expect(adoptRes.status).toBe(409);
    const pr = await request(WEB_SOCKET, `/repos/${webRepoId}/pr?branch=web`);
    expect(pr.status).toBe(200);
  });
});

describe('branch names that must not reach the filesystem', () => {
  const BAD = [
    '../../hooks/pre-commit',
    'a/../../x',
    '/etc/passwd',
    'top.md',
    'x/ai.md',
    '--help',
    'a\u0000b',
    '',
  ];

  test('each is a 400 on GET, PUT and adopt, and nothing outside the drafts dir changes', async () => {
    const outsideDrafts = () => tree(commonDir).filter((p) => !p.startsWith('diffstalker'));
    const hooks = path.join(commonDir, 'hooks');
    const hooksBefore = tree(hooks).map((name) => [
      name,
      fs.readFileSync(path.join(hooks, name), 'utf8'),
    ]);
    const before = outsideDrafts();
    const draftsBefore = tree(path.join(commonDir, 'diffstalker'));

    for (const branch of BAD) {
      const label = JSON.stringify(branch);
      expect((await getDraft(branch)).status, `GET ${label}`).toBe(400);
      expect(
        (await putDraft({ branch, top: '#!/bin/sh\necho owned\n', version: DRAFT_VERSION_ABSENT }))
          .status,
        `PUT ${label}`
      ).toBe(400);
      expect(
        (await adopt({ branch, version: DRAFT_VERSION_ABSENT })).status,
        `adopt ${label}`
      ).toBe(400);
    }

    expect(outsideDrafts()).toEqual(before);
    expect(tree(path.join(commonDir, 'diffstalker'))).toEqual(draftsBefore);
    expect(
      tree(hooks).map((name) => [name, fs.readFileSync(path.join(hooks, name), 'utf8')])
    ).toEqual(hooksBefore);
    expect(fs.existsSync('/etc/passwd/top.md')).toBe(false);
  });

  test('none of the draft routes ran gh', () => {
    expect(ghCalls).toBe(0);
  });
});
