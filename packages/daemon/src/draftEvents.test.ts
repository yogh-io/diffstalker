/**
 * `draft-change` on the repo streams: a draft saved through the daemon,
 * and one an agent writes on disk, reach a client that views the repo,
 * and neither starts a git refresh. The repo's own manager counts its
 * state-change events, since the stream skips a payload that did not
 * change and so cannot show a refresh that found nothing new.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DRAFT_VERSION_ABSENT, type DraftChangeEvent } from '@diffstalker/core/types/work';
import { createDaemon, type Daemon } from './server.js';
import {
  createFixtureRepo,
  gitExec,
  removeFixtureRepo,
  writeFixtureFile,
  SseReader,
} from './test-helpers.js';

const FIXTURE = 'daemon-draft-events';
const SOCKET = path.join(os.tmpdir(), `dsd-draftev-${process.pid}.sock`);
/** Long enough for any refresh a change could start, spacing included. */
const QUIET_MS = 1500;

let daemon: Daemon;
let repoPath: string;
let repoId: string;

function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { ...init, unix: SOCKET } as RequestInit);
}

function send(method: string, pathname: string, body: unknown): Promise<Response> {
  return request(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read events until one is a draft-change the predicate accepts. */
async function nextDraftChange(
  sse: SseReader,
  accept: (event: DraftChangeEvent) => boolean,
  timeoutMs = 5000
): Promise<DraftChangeEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evt = await sse.next(Math.max(1, deadline - Date.now()));
    if (evt.event !== 'draft-change') continue;
    const change = JSON.parse(evt.data) as DraftChangeEvent;
    if (accept(change)) return change;
  }
}

/** Counts the manager's state-change events from now on. */
function countRefreshes(): { count: number; stop: () => void } {
  const workingTree = daemon.getRepo(repoId)!.manager.workingTree;
  const counter = { count: 0, stop: () => workingTree.off('state-change', listener) };
  const listener = (): void => {
    counter.count++;
  };
  workingTree.on('state-change', listener);
  return counter;
}

function draftDir(branch: string): string {
  return path.join(repoPath, '.git', 'diffstalker', 'pr', ...branch.split('/'));
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'file.txt', 'one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -q -m initial');
  daemon = createDaemon({ updateCheck: false });
  await daemon.listen({ socketPath: SOCKET });
  const res = await send('POST', '/repos', { path: repoPath });
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('draft-change', () => {
  test('a saved draft reaches /repos/:id/events, with no refresh', async () => {
    const sse = new SseReader((await request(`/repos/${repoId}/events`)).body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      // The first view refreshes; let it finish before counting.
      await tick(QUIET_MS);
      const refreshes = countRefreshes();

      const res = await send('PUT', `/repos/${repoId}/draft`, {
        branch: 'feature',
        top: 'Why.',
        version: DRAFT_VERSION_ABSENT,
      });
      expect(res.status).toBe(200);
      // A new directory: an event at or above the branch says so.
      await nextDraftChange(
        sse,
        (c) =>
          c.branch === 'feature' ||
          (c.prefix && (c.branch === '' || 'feature'.startsWith(`${c.branch}/`)))
      );

      // Once watched, a save names the branch itself.
      await tick(300);
      const draft = (await (await request(`/repos/${repoId}/draft?branch=feature`)).json()) as {
        version: string;
      };
      await send('PUT', `/repos/${repoId}/draft`, {
        branch: 'feature',
        top: 'Why, again.',
        version: draft.version,
      });
      expect(await nextDraftChange(sse, (c) => c.branch === 'feature')).toEqual({
        branch: 'feature',
        prefix: false,
      });

      await tick(QUIET_MS);
      refreshes.stop();
      expect(refreshes.count).toBe(0);
    } finally {
      await sse.close();
    }
  }, 15000);

  test('an agent writing ai.md reaches /events?repo=, with no refresh', async () => {
    const res = await request(`/events?repo=${repoId}`);
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      expect((await sse.next(3000)).event).toBe('repo-snapshot');
      await tick(QUIET_MS);
      const refreshes = countRefreshes();

      fs.writeFileSync(path.join(draftDir('feature'), 'ai.md'), '<details>agent</details>\n');
      expect(await nextDraftChange(sse, (c) => c.branch === 'feature')).toEqual({
        branch: 'feature',
        prefix: false,
      });

      // A file the daemon does not know is no draft change.
      fs.writeFileSync(path.join(draftDir('feature'), 'notes.txt'), 'stray\n');
      await tick(QUIET_MS);
      refreshes.stop();
      expect(refreshes.count).toBe(0);
    } finally {
      await sse.close();
    }
  }, 15000);

  test('a draft made with mkdir -p and a write is reported for its branch', async () => {
    const sse = new SseReader((await request(`/repos/${repoId}/events`)).body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      await tick(300);
      fs.mkdirSync(draftDir('deep/nested/branch'), { recursive: true });
      fs.writeFileSync(
        path.join(draftDir('deep/nested/branch'), 'top.suggested.md'),
        'Suggested.\n'
      );
      const change = await nextDraftChange(
        sse,
        (c) =>
          c.branch === 'deep/nested/branch' ||
          (c.prefix && (c.branch === '' || 'deep/nested/branch'.startsWith(`${c.branch}/`)))
      );
      expect(change.prefix || change.branch === 'deep/nested/branch').toBe(true);
    } finally {
      await sse.close();
    }
  }, 15000);
});
