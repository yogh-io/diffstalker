import { describe, it, expect } from 'bun:test';
import { formatExplorerView } from './ExplorerView.js';
import type {
  ExplorerDisplayRow,
  ExplorerTreeNode,
} from '../../state/ExplorerViewModel.js';
import type { FileStatus } from '@diffstalker/core/git/status';

function node(partial: Partial<ExplorerTreeNode> & { name: string }): ExplorerTreeNode {
  return {
    path: partial.name,
    isDirectory: false,
    expanded: false,
    children: [],
    childrenLoaded: true,
    ...partial,
  };
}

function row(n: ExplorerTreeNode, over: Partial<ExplorerDisplayRow> = {}): ExplorerDisplayRow {
  return { node: n, depth: 0, isLast: false, parentIsLast: [], ...over };
}

const WIDTH = 80;

describe('formatExplorerView rendering', () => {
  const rows: ExplorerDisplayRow[] = [
    row(node({ name: 'src', isDirectory: true, expanded: false, hasChangedChildren: true })),
    row(node({ name: 'README.md' })),
    row(node({ name: 'staged.ts', gitStatus: 'added' as FileStatus }), { isLast: true }),
  ];

  it('emits no raw ANSI escape sequences', () => {
    const out = formatExplorerView(rows, 0, true, WIDTH);
    // A single ESC byte anywhere means raw SGR leaked into blessed content,
    // which surfaces as stray SGR-terminator glyphs (the t/m regression).
    expect(out).not.toContain('\x1b');
    // No {escape} wrappers — rows carry real blessed tags now.
    expect(out).not.toContain('{escape}');
  });

  it('uses blessed colour tags for git status', () => {
    // staged.ts is "added" -> green; not selected here so the name is coloured.
    const out = formatExplorerView(rows, 0, true, WIDTH);
    expect(out).toContain('{green-fg}A{/green-fg}');
    expect(out).toContain('{green-fg}staged.ts{/green-fg}');
    // directory with changed children shows a yellow bullet
    expect(out).toContain('{yellow-fg}●{/yellow-fg}');
    // tree prefix + collapsed-dir icon are blessed-tagged, not raw ANSI
    expect(out).toContain('{blue-fg}▸ {/blue-fg}');
  });

  it('marks an unmerged path U in bright red', () => {
    // It used to fall through the switch's default and render as an
    // unlabelled, uncoloured row — the one status you must not miss.
    const conflicted = [row(node({ name: 'clash.ts', gitStatus: 'conflicted' as FileStatus }))];
    const out = formatExplorerView(conflicted, 0, false, WIDTH);
    expect(out).toContain('{brightred-fg}U{/brightred-fg}');
    expect(out).toContain('{brightred-fg}clash.ts{/brightred-fg}');
  });

  it('highlights the selected+focused row with inverse cyan bold', () => {
    const out = formatExplorerView(rows, 1, true, WIDTH); // README.md selected
    expect(out).toContain('{cyan-fg}{bold}{inverse}README.md{/inverse}{/bold}{/cyan-fg}');
  });

  it('every produced line is balanced blessed markup with no stray control chars', () => {
    const out = formatExplorerView(rows, 0, true, WIDTH);
    for (const line of out.split('\n')) {
      // no control characters at all (ESC, etc.)
      expect(/[\x00-\x08\x0e-\x1f]/.test(line)).toBe(false);
      // opening and closing blessed tags balance
      const open = (line.match(/\{(?!\/)[a-z-]+\}/g) ?? []).length;
      const close = (line.match(/\{\/[a-z-]*\}/g) ?? []).length;
      expect(open).toBe(close);
    }
  });

  it('escapes braces in file names so they cannot be parsed as tags', () => {
    const weird = [row(node({ name: 'we{ir}d.ts', gitStatus: 'modified' as FileStatus }))];
    const out = formatExplorerView(weird, 0, false, WIDTH);
    expect(out).toContain('we{{ir}}d.ts');
  });
});
