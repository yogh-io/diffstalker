/**
 * ExplorerViewModel unit tests against a mocked DiffstalkerClient.
 *
 * These carry the view-model coverage that used to live on core's
 * in-process explorer manager: tree building from single-level listings,
 * single-child chain collapse, git-status application + showOnlyChanges
 * filtering, path-keyed selection retention, navigation, and — the piece
 * this layer owns — the flag->prose conversion for file previews. The
 * fs/git I/O is now the daemon's; here it is a recording fake.
 */

import { describe, test, expect } from 'bun:test';
import type { DiffstalkerClient } from '@diffstalker/client';
import type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';
import { buildGitStatusMap } from '@diffstalker/core/git/explorerData';
import { ExplorerViewModel } from './ExplorerViewModel.js';

const REPO_ID = 'abc123';
const REPO_PATH = '/fake/repo';

type Tree = Record<string, DirEntry[]>;

function file(overrides: Partial<FileForDisplay> = {}): FileForDisplay {
  return {
    content: 'hello\nworld',
    binary: false,
    truncated: false,
    tooLarge: false,
    size: 11,
    totalLines: 2,
    ...overrides,
  };
}

/**
 * A recording fake covering the three explorer endpoints the view-model
 * uses. `tree` is served from a fixture keyed by dir; `files` and `file`
 * are overridable per test.
 */
function fakeClient(opts: {
  tree?: Tree;
  files?: string[];
  file?: (path: string) => FileForDisplay;
} = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const tree = opts.tree ?? {};

  const client = {
    tree: (_id: string, o: { dir?: string; hidden?: boolean; ignored?: boolean }) => {
      calls.push({ method: 'tree', args: [o] });
      return Promise.resolve(tree[o.dir ?? ''] ?? []);
    },
    file: (_id: string, path: string) => {
      calls.push({ method: 'file', args: [path] });
      return Promise.resolve(opts.file ? opts.file(path) : file());
    },
    files: (_id: string) => {
      calls.push({ method: 'files', args: [] });
      return Promise.resolve(opts.files ?? []);
    },
  };

  return { client: client as unknown as DiffstalkerClient, calls };
}

function makeVM(
  fake: ReturnType<typeof fakeClient>,
  repoId: string | null = REPO_ID
): ExplorerViewModel {
  return new ExplorerViewModel(fake.client, repoId, REPO_PATH, {});
}

describe('ExplorerViewModel tree loading', () => {
  test('loadTree lists the root: dirs first, files after', async () => {
    const fake = fakeClient({
      tree: {
        '': [
          { name: 'src', path: 'src', type: 'dir' },
          { name: 'README.md', path: 'README.md', type: 'file' },
        ],
      },
    });
    const vm = makeVM(fake);
    await vm.loadTree();

    const rows = vm.state.displayRows;
    expect(rows.map((r) => r.node.name)).toEqual(['src', 'README.md']);
    expect(rows[0].node.isDirectory).toBe(true);
    expect(rows[1].node.isDirectory).toBe(false);
  });

  test('tree call inverts hide options into show flags', async () => {
    const fake = fakeClient({ tree: { '': [] } });
    const vm = makeVM(fake);
    await vm.loadTree();

    const treeCall = fake.calls.find((c) => c.method === 'tree');
    expect(treeCall?.args[0]).toEqual({ dir: '', hidden: false, ignored: false });
  });

  test('collapses single-child directory chains', async () => {
    const fake = fakeClient({
      tree: {
        '': [{ name: 'a', path: 'a', type: 'dir' }],
        a: [{ name: 'b', path: 'a/b', type: 'dir' }],
        'a/b': [{ name: 'file.ts', path: 'a/b/file.ts', type: 'file' }],
      },
    });
    const vm = makeVM(fake);
    await vm.loadTree();
    // Pre-expand the chain so children load recursively.
    await vm.navigateToPath('a/b/file.ts');

    const dirRow = vm.state.displayRows.find((r) => r.node.isDirectory);
    expect(dirRow?.node.name).toBe('a/b');
  });

  test('a null repo id yields an empty tree (not-a-repo mode)', async () => {
    const fake = fakeClient({ tree: { '': [{ name: 'x', path: 'x', type: 'file' }] } });
    const vm = makeVM(fake, null);
    await vm.loadTree();

    expect(vm.state.displayRows).toEqual([]);
    expect(fake.calls.some((c) => c.method === 'tree')).toBe(false);
  });
});

describe('ExplorerViewModel git status + filtering', () => {
  test('applies status markers and showOnlyChanges filters to changed only', async () => {
    const fake = fakeClient({
      tree: {
        '': [
          { name: 'src', path: 'src', type: 'dir' },
          { name: 'clean.ts', path: 'clean.ts', type: 'file' },
        ],
        src: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' }],
      },
    });
    const vm = makeVM(fake);
    await vm.loadTree();
    await vm.navigateToPath('src/app.ts'); // expands src
    vm.setGitStatus(
      buildGitStatusMap([{ path: 'src/app.ts', status: 'modified', staged: false }])
    );

    const appRow = vm.state.displayRows.find((r) => r.node.path === 'src/app.ts');
    expect(appRow?.node.gitStatus).toBe('modified');
    const srcRow = vm.state.displayRows.find((r) => r.node.path === 'src');
    expect(srcRow?.node.hasChangedChildren).toBe(true);

    await vm.toggleShowOnlyChanges();
    const paths = vm.state.displayRows.map((r) => r.node.path);
    expect(paths).toContain('src');
    expect(paths).toContain('src/app.ts');
    expect(paths).not.toContain('clean.ts');
  });
});

describe('ExplorerViewModel loadFile flag->prose', () => {
  async function selectFileWithFlags(flags: Partial<FileForDisplay>) {
    const fake = fakeClient({
      tree: { '': [{ name: 'f.txt', path: 'f.txt', type: 'file' }] },
      file: () => file(flags),
    });
    const vm = makeVM(fake);
    await vm.loadTree();
    await vm.selectIndex(0);
    return vm.state.selectedFile;
  }

  test('binary file gets the binary prose', async () => {
    const selected = await selectFileWithFlags({ binary: true, content: '' });
    expect(selected?.content).toBe('Binary file - cannot display');
  });

  test('too-large file reports size and the max', async () => {
    const selected = await selectFileWithFlags({ tooLarge: true, content: '', size: 2 * 1024 * 1024 });
    expect(selected?.content).toContain('File too large to display (2.00 MB)');
    expect(selected?.content).toContain('Maximum size: 1 MB');
    expect(selected?.truncated).toBe(true);
  });

  test('truncated file appends the dropped-line notice', async () => {
    const selected = await selectFileWithFlags({
      truncated: true,
      totalLines: 5200,
      content: 'x',
    });
    expect(selected?.content).toContain('... (truncated, 200 more lines)');
    expect(selected?.truncated).toBe(true);
  });

  test('large-but-not-truncated file gets the size warning prepended', async () => {
    const selected = await selectFileWithFlags({ size: 200 * 1024, content: 'body' });
    expect(selected?.content.startsWith('Warning: Large file (200.0 KB)')).toBe(true);
    expect(selected?.content).toContain('body');
    expect(selected?.truncated).toBe(false);
  });

  test('a daemon error becomes error prose in the preview', async () => {
    const fake = fakeClient({
      tree: { '': [{ name: 'f.txt', path: 'f.txt', type: 'file' }] },
    });
    // Override file() to reject.
    (fake.client as unknown as { file: () => Promise<never> }).file = () =>
      Promise.reject(new Error('boom'));
    const vm = makeVM(fake);
    await vm.loadTree();
    await vm.selectIndex(0);
    expect(vm.state.selectedFile?.content).toBe('Error: boom');
  });
});

describe('ExplorerViewModel navigation + file finder', () => {
  test('navigateToPath expands parents and selects the file', async () => {
    const fake = fakeClient({
      tree: {
        '': [{ name: 'src', path: 'src', type: 'dir' }],
        src: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' }],
      },
    });
    const vm = makeVM(fake);
    await vm.loadTree();
    const ok = await vm.navigateToPath('src/app.ts');
    expect(ok).toBe(true);
    const selected = vm.state.displayRows[vm.state.selectedIndex];
    expect(selected.node.path).toBe('src/app.ts');
  });

  test('loadFilePaths caches the daemon /files list for the finder', async () => {
    const fake = fakeClient({ files: ['a.ts', 'src/b.ts'] });
    const vm = makeVM(fake);
    await vm.loadFilePaths();
    expect(vm.getCachedFilePaths()).toEqual(['a.ts', 'src/b.ts']);
  });

  test('loadFilePaths is empty in not-a-repo mode', async () => {
    const fake = fakeClient({ files: ['a.ts'] });
    const vm = makeVM(fake, null);
    await vm.loadFilePaths();
    expect(vm.getCachedFilePaths()).toEqual([]);
  });
});
