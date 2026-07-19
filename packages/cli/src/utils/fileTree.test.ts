import { describe, it, expect } from 'vitest';
import { buildFileTree, flattenTree, buildTreePrefix } from './fileTree.js';

describe('buildFileTree', () => {
  it('builds tree from flat file paths', () => {
    const files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
    const root = buildFileTree(files);
    expect(root.children.length).toBe(1); // 'src' directory
    expect(root.children[0].name).toBe('src');
    expect(root.children[0].children.length).toBe(2);
  });

  it('collapses single-child directory chains', () => {
    const files = [{ path: 'a/b/c/file.ts' }];
    const root = buildFileTree(files);
    // a/b/c should be collapsed into a single node
    expect(root.children[0].name).toBe('a/b/c');
    expect(root.children[0].isDirectory).toBe(true);
  });

  it('does not collapse directories with multiple children', () => {
    const files = [{ path: 'a/b/file1.ts' }, { path: 'a/c/file2.ts' }];
    const root = buildFileTree(files);
    // 'a' has two children (b and c), so it should not be collapsed
    expect(root.children[0].name).toBe('a');
    expect(root.children[0].children.length).toBe(2);
  });

  it('sorts directories before files', () => {
    const files = [{ path: 'file.ts' }, { path: 'dir/nested.ts' }];
    const root = buildFileTree(files);
    expect(root.children[0].isDirectory).toBe(true);
    expect(root.children[1].isDirectory).toBe(false);
  });

  it('sorts alphabetically within same type', () => {
    const files = [{ path: 'c.ts' }, { path: 'a.ts' }, { path: 'b.ts' }];
    const root = buildFileTree(files);
    expect(root.children.map((c) => c.name)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('handles single file', () => {
    const files = [{ path: 'readme.md' }];
    const root = buildFileTree(files);
    expect(root.children.length).toBe(1);
    expect(root.children[0].name).toBe('readme.md');
    expect(root.children[0].isDirectory).toBe(false);
  });

  it('handles empty input', () => {
    const root = buildFileTree([]);
    expect(root.children.length).toBe(0);
  });

  it('preserves fileIndex on leaf nodes', () => {
    const files = [{ path: 'a.ts' }, { path: 'b.ts' }];
    const root = buildFileTree(files);
    expect(root.children[0].fileIndex).toBe(0);
    expect(root.children[1].fileIndex).toBe(1);
  });
});

describe('flattenTree', () => {
  it('produces rows from tree', () => {
    const files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
    const root = buildFileTree(files);
    const rows = flattenTree(root);
    // src dir + 2 files
    expect(rows.length).toBe(3);
    expect(rows[0].type).toBe('directory');
    expect(rows[1].type).toBe('file');
    expect(rows[2].type).toBe('file');
  });

  it('marks last child correctly', () => {
    const files = [{ path: 'a.ts' }, { path: 'b.ts' }];
    const root = buildFileTree(files);
    const rows = flattenTree(root);
    expect(rows[0].isLast).toBe(false);
    expect(rows[1].isLast).toBe(true);
  });

  it('tracks parentIsLast for nested items', () => {
    const files = [{ path: 'src/a.ts' }, { path: 'other.ts' }];
    const root = buildFileTree(files);
    const rows = flattenTree(root);
    // src dir -> not last (other.ts follows)
    const srcRow = rows.find((r) => r.name === 'src');
    expect(srcRow?.isLast).toBe(false);
    // a.ts inside src -> parentIsLast should indicate src was not last
    const aRow = rows.find((r) => r.name === 'a.ts');
    expect(aRow?.parentIsLast).toEqual([false]);
  });

  it('returns empty for empty tree', () => {
    const root = buildFileTree([]);
    expect(flattenTree(root)).toEqual([]);
  });
});

describe('buildTreePrefix', () => {
  it('builds connector for non-last item', () => {
    const prefix = buildTreePrefix({
      type: 'file',
      name: 'a.ts',
      fullPath: 'a.ts',
      depth: 0,
      isLast: false,
      parentIsLast: [],
    });
    expect(prefix).toBe('\u251c '); // '├ '
  });

  it('builds connector for last item', () => {
    const prefix = buildTreePrefix({
      type: 'file',
      name: 'b.ts',
      fullPath: 'b.ts',
      depth: 0,
      isLast: true,
      parentIsLast: [],
    });
    expect(prefix).toBe('\u2514 '); // '└ '
  });

  it('adds vertical lines for non-last parents', () => {
    const prefix = buildTreePrefix({
      type: 'file',
      name: 'nested.ts',
      fullPath: 'src/nested.ts',
      depth: 1,
      isLast: true,
      parentIsLast: [false],
    });
    expect(prefix).toBe('\u2502 \u2514 '); // '│ └ '
  });

  it('adds spaces for last parents', () => {
    const prefix = buildTreePrefix({
      type: 'file',
      name: 'nested.ts',
      fullPath: 'src/nested.ts',
      depth: 1,
      isLast: true,
      parentIsLast: [true],
    });
    expect(prefix).toBe('  \u2514 '); // '  └ '
  });
});
