/**
 * Settings + discovery over the API: what a watch directory does when it
 * is saved, refused, or removed.
 *
 * The daemon here gets a temp settings file (never the user's real
 * ~/.config/diffstalker/daemon.json) and a temp scan root. The repos in
 * that root are made with `git init` so this stays honest about what a
 * real repo looks like on disk.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { SettingsStore, normalizeWatchRoot } from './settings.js';
import { SseReader } from './test-helpers.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-settings-${process.pid}.sock`);

let daemon: Daemon;
let workDir: string;
let scanRoot: string;
let settingsFile: string;

function api(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    unix: SOCKET,
  } as RequestInit);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init --initial-branch=main', { cwd: dir, stdio: 'ignore' });
}

beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-settings-')));
  scanRoot = path.join(workDir, 'projects');
  settingsFile = path.join(workDir, 'config', 'daemon.json');

  initRepo(path.join(scanRoot, 'alpha'));
  initRepo(path.join(scanRoot, 'beta'));
  initRepo(path.join(scanRoot, 'group', 'gamma'));
  fs.mkdirSync(path.join(scanRoot, 'not-a-repo'), { recursive: true });

  // No followFile: no chokidar watcher on the hook file.
  daemon = createDaemon({ settingsFile });
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('GET /settings', () => {
  test('starts empty and reports that it persists', async () => {
    const res = await api('GET', '/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ watchRoots: [], persisted: true });
  });
});

describe('PUT /settings', () => {
  test('refuses a relative path, naming it', async () => {
    const res = await api('PUT', '/settings', { watchRoots: ['some/where'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('must be absolute');
  });

  test('refuses a directory that does not exist', async () => {
    const res = await api('PUT', '/settings', { watchRoots: [path.join(workDir, 'nope')] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('No such directory');
  });

  test('refuses a file', async () => {
    const file = path.join(workDir, 'a-file');
    fs.writeFileSync(file, 'x');
    const res = await api('PUT', '/settings', { watchRoots: [file] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Not a directory');
  });

  test('refuses a body without a watchRoots array', async () => {
    const res = await api('PUT', '/settings', { watchRoots: 'a-string' });
    expect(res.status).toBe(400);
  });

  test('nothing was saved by any of the refusals', async () => {
    expect(await (await api('GET', '/settings')).json()).toEqual({
      watchRoots: [],
      persisted: true,
    });
  });

  test('saves a root, scans it before replying, and persists to the file', async () => {
    const res = await api('PUT', '/settings', { watchRoots: [`${scanRoot}/`] });
    expect(res.status).toBe(200);
    // The trailing slash normalized away.
    expect((await res.json()).watchRoots).toEqual([scanRoot]);

    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(stored.watchRoots).toEqual([scanRoot]);

    const discovered = await (await api('GET', '/discovered')).json();
    expect(discovered.roots).toHaveLength(1);
    expect(discovered.roots[0].error).toBe(null);
    expect(discovered.roots[0].repos.map((repo: { name: string }) => repo.name).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(discovered.roots[0].repos[0].branch).toBe('main');
  });

  test('a duplicate spelling of the same root collapses to one', async () => {
    const res = await api('PUT', '/settings', {
      watchRoots: [scanRoot, `${scanRoot}/`, `${scanRoot}/.`],
    });
    expect((await res.json()).watchRoots).toEqual([scanRoot]);
  });
});

describe('discovery', () => {
  test('POST /discovered/rescan picks up a repo created since the save', async () => {
    initRepo(path.join(scanRoot, 'delta'));
    const state = await (await api('POST', '/discovered/rescan')).json();
    expect(state.roots[0].repos.map((repo: { name: string }) => repo.name)).toContain('delta');
    fs.rmSync(path.join(scanRoot, 'delta'), { recursive: true, force: true });
  });

  test('a saved root that has since been removed reports its error, keeping the setting', async () => {
    const gone = path.join(workDir, 'gone');
    fs.mkdirSync(gone, { recursive: true });
    await api('PUT', '/settings', { watchRoots: [scanRoot, gone] });
    fs.rmSync(gone, { recursive: true, force: true });

    const state = await (await api('POST', '/discovered/rescan')).json();
    const removed = state.roots.find((root: { path: string }) => root.path === gone);
    expect(removed.error).toBeTruthy();
    expect(removed.repos).toEqual([]);

    // The setting itself is untouched: a vanished disk must not silently
    // delete what the user configured.
    expect((await (await api('GET', '/settings')).json()).watchRoots).toEqual([scanRoot, gone]);
  });

  test('a clone into a watched root shows up without anyone asking', async () => {
    await api('PUT', '/settings', { watchRoots: [scanRoot] });
    const stream = await fetch('http://localhost/events', { unix: SOCKET } as RequestInit);
    const reader = new SseReader(stream.body!);
    expect((await reader.next(2000)).event).toBe('snapshot');

    initRepo(path.join(scanRoot, 'epsilon'));
    try {
      // The watcher debounces, and a directory add lands as several fs
      // events, so read until the state that mentions it arrives.
      let names: string[] = [];
      for (let attempt = 0; attempt < 5 && !names.includes('epsilon'); attempt++) {
        const event = await reader.next(4000);
        if (event.event !== 'discovery-change') continue;
        names = JSON.parse(event.data).roots[0].repos.map((repo: { name: string }) => repo.name);
      }
      expect(names).toContain('epsilon');
    } finally {
      await reader.close();
      fs.rmSync(path.join(scanRoot, 'epsilon'), { recursive: true, force: true });
    }
  });

  test('removing a root drops it from discovery', async () => {
    await api('PUT', '/settings', { watchRoots: [] });
    expect(await (await api('GET', '/discovered')).json()).toEqual({ roots: [] });
  });
});

describe('GET /browse', () => {
  test('lists subdirectories, marking the ones that are repos', async () => {
    const res = await api('GET', `/browse?path=${encodeURIComponent(scanRoot)}`);
    expect(res.status).toBe(200);
    const listing = await res.json();

    expect(listing.path).toBe(scanRoot);
    expect(listing.parent).toBe(workDir);
    const byName = new Map(
      listing.entries.map((entry: { name: string; isRepo: boolean }) => [entry.name, entry.isRepo])
    );
    expect(byName.get('alpha')).toBe(true);
    expect(byName.get('group')).toBe(false); // a folder of repos, not a repo
    expect(byName.get('not-a-repo')).toBe(false);
  });

  test('no path starts at the daemon home, which has no missing parent', async () => {
    const listing = await (await api('GET', '/browse')).json();
    expect(listing.path).toBe(os.homedir());
    expect(listing.home).toBe(os.homedir());
  });

  test('lists directories only — never file names', async () => {
    fs.writeFileSync(path.join(scanRoot, 'a-loose-file.txt'), 'x');
    const listing = await (await api('GET', `/browse?path=${encodeURIComponent(scanRoot)}`)).json();
    expect(listing.entries.map((entry: { name: string }) => entry.name)).not.toContain(
      'a-loose-file.txt'
    );
  });

  test('404s for a directory that is not there', async () => {
    const res = await api('GET', `/browse?path=${encodeURIComponent(path.join(workDir, 'nope'))}`);
    expect(res.status).toBe(404);
  });

  test('refuses a relative path', async () => {
    const res = await api('GET', '/browse?path=some/where');
    expect(res.status).toBe(400);
  });
});

describe('daemon SSE', () => {
  test('a save broadcasts settings-change and discovery-change', async () => {
    const stream = await fetch('http://localhost/events', { unix: SOCKET } as RequestInit);
    const reader = new SseReader(stream.body!);
    expect((await reader.next(2000)).event).toBe('snapshot');

    await api('PUT', '/settings', { watchRoots: [scanRoot] });

    const events = [(await reader.next(2000)).event, (await reader.next(2000)).event];
    expect(events).toContain('discovery-change');
    expect(events).toContain('settings-change');
    await reader.close();
    await api('PUT', '/settings', { watchRoots: [] });
  });
});

describe('SettingsStore', () => {
  test('a corrupt file degrades to defaults instead of throwing', () => {
    const file = path.join(workDir, 'corrupt.json');
    fs.writeFileSync(file, '{ not json');
    expect(new SettingsStore(file).load()).toEqual({ watchRoots: [] });
  });

  test('unknown fields and non-string entries are dropped on read', () => {
    const file = path.join(workDir, 'partial.json');
    fs.writeFileSync(file, JSON.stringify({ watchRoots: ['/a', 7, null], nonsense: true }));
    expect(new SettingsStore(file).load()).toEqual({ watchRoots: ['/a'] });
  });

  test('a store with no file applies settings but reports persisted: false', () => {
    const store = new SettingsStore(null);
    expect(store.persisted).toBe(false);
    expect(store.save({ watchRoots: ['/a'] })).toEqual({ watchRoots: ['/a'] });
    expect(store.settings.watchRoots).toEqual(['/a']);
  });

  test('normalizeWatchRoot expands ~', () => {
    expect(normalizeWatchRoot('~')).toBe(os.homedir());
  });
});
