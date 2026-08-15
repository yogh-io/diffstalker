import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LinkError, buildLink, parseLinkArgs, resolveBaseUrl } from './link';
import type { LinkClient } from './link';

/**
 * A fake daemon. CLI tests never reach a real one — and this file in
 * particular must not, since every assertion here is about what the command
 * REFUSES to build.
 */
function fakeClient(overrides: Partial<Record<keyof LinkClient, unknown>> = {}): LinkClient {
  const base = {
    health: async () => ({ ok: true, ready: true, home: '/home/u', http: { port: 7337 } }),
    openRepo: async () => ({ id: 'r1', path: REPO }),
    closeRepo: async () => {},
    status: async () => ({
      status: {
        isRepo: true,
        branch: { current: 'main', ahead: 0, behind: 0 },
        files: [
          { path: 'edited.ts', status: 'modified', staged: false },
          { path: 'staged.ts', status: 'modified', staged: true },
          { path: 'both.ts', status: 'modified', staged: true },
          { path: 'both.ts', status: 'modified', staged: false },
        ],
      },
    }),
    history: async () => [
      { hash: 'aaaaaaaabbbbbbbb', shortHash: 'aaaaaaa' },
      { hash: 'ccccccccdddddddd', shortHash: 'ccccccc' },
    ],
  };
  return { ...base, ...overrides } as unknown as LinkClient;
}

/** A real directory with real files — the existence check is not mocked. */
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'dslink-'));
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
for (const name of ['edited.ts', 'staged.ts', 'both.ts', 'clean.ts']) {
  fs.writeFileSync(path.join(REPO, name), '');
}
fs.writeFileSync(path.join(REPO, 'src', 'App.vue'), '');

const ENV = {} as NodeJS.ProcessEnv;

function args(argv: string[]) {
  return parseLinkArgs(argv, REPO);
}

function link(argv: string[], client: LinkClient = fakeClient(), env = ENV): Promise<string> {
  return buildLink(args(argv), env, client, '/sock');
}

describe('parseLinkArgs', () => {
  test('nothing is the journal — the whole session, one place', () => {
    expect(args([])).toMatchObject({ view: 'journal', target: null });
  });

  test('a bare path is the explorer', () => {
    expect(args(['src/App.vue'])).toMatchObject({ view: 'explorer', target: 'src/App.vue' });
  });

  test('a view keyword wins over reading the token as a path', () => {
    expect(args(['history'])).toMatchObject({ view: 'history', target: null });
  });

  test('./ forces the path reading of a colliding name', () => {
    expect(args(['./history'])).toMatchObject({ view: 'explorer', target: './history' });
  });

  test('--base is rejected for a view that has no base', () => {
    expect(() => args(['explorer', 'a.ts', '--base', 'main'])).toThrow(LinkError);
  });

  test('journal takes no anchor', () => {
    expect(() => args(['journal', 'a.ts'])).toThrow(/no anchor/);
  });

  test('an option with no value, and an unknown option, are refused', () => {
    expect(() => args(['compare', '--base'])).toThrow(/needs a value/);
    expect(() => args(['--wat'])).toThrow(/unknown option/);
  });
});

describe('resolveBaseUrl', () => {
  test('uses the port the daemon reports', () => {
    expect(resolveBaseUrl(7337, {} as NodeJS.ProcessEnv)).toBe('http://localhost:7337');
  });

  test('DIFFSTALKER_WEB_URL wins, trailing slashes trimmed', () => {
    const env = { DIFFSTALKER_WEB_URL: 'http://diffstalker.localhost:7337/' };
    expect(resolveBaseUrl(7337, env as NodeJS.ProcessEnv)).toBe('http://diffstalker.localhost:7337');
  });

  test('a socket-only daemon is an error, not a guessed port', () => {
    // Guessing would produce a link that fails at click time, in someone
    // else's browser, with no clue why.
    expect(() => resolveBaseUrl(null, {} as NodeJS.ProcessEnv)).toThrow(/no web UI/);
  });
});

describe('buildLink', () => {
  test('journal names the repo and nothing else', async () => {
    expect(await link([])).toBe(`http://localhost:7337/journal${REPO}`);
  });

  test('explorer anchors on the repo-relative path', async () => {
    expect(await link(['src/App.vue'])).toBe(`http://localhost:7337/explorer${REPO}?at=src/App.vue`);
  });

  test('a path outside the repo is refused', async () => {
    await expect(link(['/etc/hostname'])).rejects.toThrow(/outside the repo/);
  });

  test('a path that does not exist is refused', async () => {
    await expect(link(['src/Nope.vue'])).rejects.toThrow(/no such file/);
  });

  test('the repo root is not a file anchor, and says what to do instead', async () => {
    await expect(link(['.'])).rejects.toThrow(/repo root[\s\S]*Drop the target/);
  });

  describe('changes anchors carry the side', () => {
    test('an unstaged file gets u:', async () => {
      expect(await link(['changes', 'edited.ts'])).toContain('?at=u:edited.ts');
    });

    test('a staged file gets s:', async () => {
      expect(await link(['changes', 'staged.ts'])).toContain('?at=s:staged.ts');
    });

    test('a partially staged file points at the live edit', async () => {
      expect(await link(['changes', 'both.ts'])).toContain('?at=u:both.ts');
    });

    test('a clean file has no row, and the error names the view that works', async () => {
      await expect(link(['changes', 'clean.ts'])).rejects.toThrow(
        /no uncommitted changes[\s\S]*link explorer clean\.ts/
      );
    });
  });

  describe('history anchors resolve to a short hash', () => {
    test('HEAD is the newest commit', async () => {
      expect(await link(['history', 'HEAD'])).toContain('?at=aaaaaaa');
    });

    test('a full hash resolves to its short form', async () => {
      expect(await link(['history', 'ccccccccdddddddd'])).toContain('?at=ccccccc');
    });

    test('an unknown hash is refused rather than linked blind', async () => {
      await expect(link(['history', 'deadbeef'])).rejects.toThrow(/not one of the last/);
    });

    test('a repo with no commits says so', async () => {
      const client = fakeClient({ history: async () => [] });
      await expect(link(['history', 'HEAD'], client)).rejects.toThrow(/no commits/);
    });
  });

  test('compare carries the base', async () => {
    const url = await link(['compare', 'src/App.vue', '--base', 'upstream/main']);
    expect(url).toBe(`http://localhost:7337/compare${REPO}?base=upstream/main&at=src/App.vue`);
  });

  test('a home-relative repo collapses to the sentinel', async () => {
    const client = fakeClient({
      health: async () => ({ ok: true, ready: true, home: REPO, http: { port: 7337 } }),
    });
    expect(await link([], client)).toBe('http://localhost:7337/journal/~');
  });

  test('an unreachable daemon names the socket it tried', async () => {
    const client = fakeClient({
      health: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(link([], client)).rejects.toThrow(/no diffstalkerd is listening on \/sock/);
  });

  test('a path that is not a repo is refused', async () => {
    const client = fakeClient({
      openRepo: async () => {
        throw new Error('not a repo');
      },
    });
    await expect(link([], client)).rejects.toThrow(/not inside a git repository/);
  });

  test('the repo ref it took is always released, including on failure', async () => {
    let closed = 0;
    const client = fakeClient({
      closeRepo: async () => {
        closed += 1;
      },
    });
    await link([], client);
    expect(closed).toBe(1);
    await expect(link(['src/Nope.vue'], client)).rejects.toThrow();
    expect(closed).toBe(2);
  });

  test('a socket-only daemon fails before opening a repo', async () => {
    // Order matters: the refcount must not be taken for a link that cannot
    // be built anyway.
    let opened = 0;
    const client = fakeClient({
      health: async () => ({ ok: true, ready: true, home: '/home/u', http: { port: null } }),
      openRepo: async () => {
        opened += 1;
        return { id: 'r1', path: REPO };
      },
    });
    await expect(link([], client)).rejects.toThrow(/no web UI/);
    expect(opened).toBe(0);
  });

  test('a daemon too old to report a port is treated as socket-only', async () => {
    const client = fakeClient({
      health: async () => ({ ok: true, ready: true, home: '/home/u' }),
    });
    await expect(link([], client)).rejects.toThrow(/no web UI/);
  });
});
