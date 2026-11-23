/**
 * The two PR routes that run gh: `/pr/check` reads one PR fresh, and
 * `/pr/top` writes top.md into the PR's top zone, keeping GitHub's lower
 * zone. A scripted fake gh plays GitHub: no test runs the real one. What
 * matters most: nothing is written when top.md has a placeholder, when it
 * changed since it was shown, or when GitHub's top zone changed; and the
 * text goes in on stdin, never as an argument.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DRAFT_VERSION_ABSENT, type BranchPr, type PrDraft } from '@diffstalker/core/types/work';
import { createDaemon, type Daemon } from './server.js';
import { OPEN_SEARCH, PR_ONE_QUERY, UPDATE_BODY_MUTATION, type GhRunner } from './github.js';
import { createFixtureRepo, gitExec, removeFixtureRepo, writeFixtureFile } from './test-helpers.js';

const FIXTURE = 'daemon-pr-top';
const SOCKET = path.join(os.tmpdir(), `dsd-prtop-${process.pid}.sock`);
const LOWER =
  '---\n<details>\n<summary>LLM-generated technical summary</summary>\n\nAI.\n</details>';

let daemon: Daemon;
let repoId: string;
let tmpDir: string;
/** The PR body as the fake GitHub has it. */
let githubBody: string;
let calls: Array<{ args: string[]; input: string | undefined }>;

function prNode(): Record<string, unknown> {
  return {
    id: 'PR_node',
    number: 7,
    title: 'A change',
    url: 'https://github.com/aerius/calculator/pull/7',
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00Z',
    headRefName: 'feature',
    headRefOid: 'abc',
    baseRefName: 'main',
    headRepositoryOwner: { login: 'JornC' },
    author: { __typename: 'User', login: 'JornC' },
    repository: { nameWithOwner: 'aerius/calculator' },
    body: githubBody,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviewRequests: { totalCount: 0, nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  };
}

const fakeGh: GhRunner = {
  available: () => true,
  run: async (args, _timeout, input) => {
    calls.push({ args: [...args], input });
    if (input !== undefined && input !== '') {
      const request = JSON.parse(input) as { query: string; variables: Record<string, unknown> };
      if (request.query === UPDATE_BODY_MUTATION) {
        githubBody = String(request.variables.body);
        return JSON.stringify({ data: { updatePullRequest: { pullRequest: prNode() } } });
      }
      return JSON.stringify({ data: { repository: { pullRequest: prNode() } } });
    }
    const page = (nodes: unknown[]) => ({
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes,
    });
    if (args.includes(`q=${OPEN_SEARCH}`)) {
      return JSON.stringify({ data: { viewer: { login: 'JornC' }, search: page([prNode()]) } });
    }
    return JSON.stringify({ data: { search: page([]) } });
  },
};

function send(method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`http://localhost${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    unix: SOCKET,
  } as RequestInit);
}

async function saveTop(top: string, branch = 'feature'): Promise<PrDraft> {
  const current = (await (
    await send('GET', `/repos/${repoId}/draft?branch=${branch}`)
  ).json()) as PrDraft;
  const res = await send('PUT', `/repos/${repoId}/draft`, {
    branch,
    top,
    version: current.version,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PrDraft;
}

const mutations = () =>
  calls.filter((call) => call.input !== undefined && call.input.includes('updatePullRequest'));

beforeAll(async () => {
  const repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'file.txt', 'one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -q -m initial');
  gitExec(repoPath, 'remote add upstream https://github.com/aerius/calculator.git');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prtop-test-'));
  daemon = createDaemon({
    gh: fakeGh,
    workMarksFile: path.join(tmpDir, 'work.json'),
    updateCheck: false,
  });
  await daemon.listen({ socketPath: SOCKET });
  const res = await send('POST', '/repos', { path: repoPath });
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  githubBody = `Old words.\n\n${LOWER}`;
  calls = [];
  expect((await send('POST', '/work/prs/refresh')).status).toBe(200);
  calls = [];
});

describe('POST /repos/:id/pr/top', () => {
  test('replaces the top zone, keeps the lower zone, and the cached PR follows', async () => {
    const draft = await saveTop('New words.\n');
    const res = await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'feature',
      version: draft.version,
      expectedTop: 'Old words.',
    });
    expect(res.status).toBe(200);
    expect(githubBody).toBe(`New words.\n\n${LOWER}`);
    expect(((await res.json()) as BranchPr).pr?.body).toBe(githubBody);
    const cached = (await (
      await send('GET', `/repos/${repoId}/pr?branch=feature`)
    ).json()) as BranchPr;
    expect(cached.pr?.body).toBe(githubBody);
  });

  test('the text goes in on stdin: the argv is fixed', async () => {
    const draft = await saveTop('Words with "quotes" and --flags.\n');
    await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'feature',
      version: draft.version,
      expectedTop: 'Old words.',
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['api', 'graphql', '--input', '-'],
      ['api', 'graphql', '--input', '-'],
    ]);
    const [read, write] = calls.map((call) => JSON.parse(call.input ?? '') as { query: string });
    expect(read.query).toBe(PR_ONE_QUERY);
    expect(write.query).toBe(UPDATE_BODY_MUTATION);
  });

  test('GitHub top zone changed since it was shown: 409, nothing written', async () => {
    const draft = await saveTop('New words.\n');
    githubBody = `Someone edited this on GitHub.\n\n${LOWER}`;
    const res = await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'feature',
      version: draft.version,
      expectedTop: 'Old words.',
    });
    expect(res.status).toBe(409);
    expect(mutations()).toHaveLength(0);
    expect(githubBody).toBe(`Someone edited this on GitHub.\n\n${LOWER}`);
  });

  test('a placeholder in top.md: 422, gh not run', async () => {
    const draft = await saveTop('Why {{reason}}.\n');
    const res = await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'feature',
      version: draft.version,
      expectedTop: 'Old words.',
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  test('top.md changed since it was shown: 409, gh not run', async () => {
    await saveTop('New words.\n');
    const res = await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'feature',
      version: DRAFT_VERSION_ABSENT,
      expectedTop: 'Old words.',
    });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test('an empty top.md: 422, gh not run', async () => {
    const res = await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'empty',
      version: DRAFT_VERSION_ABSENT,
      expectedTop: '',
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  test('a branch with no known PR is a 404', async () => {
    const draft = await saveTop('Words.\n', 'other');
    const res = await send('POST', `/repos/${repoId}/pr/top`, {
      branch: 'other',
      version: draft.version,
      expectedTop: '',
    });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /repos/:id/pr/check', () => {
  test('reads the one PR fresh and puts it in the cached list', async () => {
    githubBody = `Changed on GitHub.\n\n${LOWER}`;
    const res = await send('POST', `/repos/${repoId}/pr/check`, { branch: 'feature' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as BranchPr).pr?.body).toBe(githubBody);
    expect(calls).toHaveLength(1);
    const variables = (JSON.parse(calls[0].input ?? '') as { variables: unknown }).variables;
    expect(variables).toEqual({ owner: 'aerius', name: 'calculator', number: 7 });
  });

  test('GET is not routed', async () => {
    const res = await send('GET', `/repos/${repoId}/pr/check?branch=feature`);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
