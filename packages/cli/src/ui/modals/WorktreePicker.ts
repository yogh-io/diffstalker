import * as path from 'node:path';
import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { abbreviateHomePath } from '../../config.js';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';
import type { Modal } from './Modal.js';

const FOOTER = 'j/k: navigate | Enter: select | Esc: cancel';

/** Directory shared by every worktree, or null if they don't all share one. */
function commonParentDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const dirs = paths.map((p) => path.dirname(p));
  return dirs.every((d) => d === dirs[0]) ? dirs[0] : null;
}

/** Plain-text truncation with an ellipsis (no blessed tags in the input). */
function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…';
}

interface Row {
  name: string; // basename (parent mode) or abbreviated full path
  annotation: string; // branch/detached note, shown only when informative
  isCurrent: boolean;
  path: string;
}

/**
 * WorktreePicker modal for switching between the worktrees of the current
 * repository. Used both when opening a bare-repo container (which worktree?)
 * and as a switcher between sibling worktrees.
 */
export class WorktreePicker implements Modal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private rows: Row[];
  private parentLabel: string | null;
  private selectedIndex: number;
  private onSelect: (worktreePath: string) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    worktrees: WorktreeInfo[],
    currentPath: string,
    onSelect: (worktreePath: string) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // When every worktree lives in the same directory (the common bare-repo
    // layout), show that directory once and list just the worktree names —
    // the full path per row is redundant and causes wrapping.
    const parent = commonParentDir(worktrees.map((w) => w.path));
    this.parentLabel = parent ? abbreviateHomePath(parent) : null;

    this.rows = worktrees.map((w) => {
      const base = path.basename(w.path);
      const name = parent ? base : abbreviateHomePath(w.path);
      // Annotate the branch only when it isn't already obvious from the name.
      let annotation = '';
      if (!w.branch) annotation = '(detached)';
      else if (w.branch !== base) annotation = `→ ${w.branch}`;
      return { name, annotation, isCurrent: w.path === currentPath, path: w.path };
    });

    this.selectedIndex = Math.max(
      0,
      worktrees.findIndex((w) => w.path === currentPath)
    );

    // Widest rendered line (each line has a 1-char left margin / 2-char marker).
    const rowWidth = (r: Row) =>
      2 + r.name.length + (r.annotation ? 2 + r.annotation.length : 0) + (r.isCurrent ? 10 : 0);
    const screenWidth = screen.width as number;
    const longest = Math.max(
      ' Worktrees'.length,
      this.parentLabel ? this.parentLabel.length + 1 : 0,
      FOOTER.length + 1,
      ...this.rows.map(rowWidth)
    );
    const width = Math.min(Math.max(longest + 4, 32), screenWidth - 4);
    const maxVisible = Math.min(worktrees.length, 15);
    const height = maxVisible + (this.parentLabel ? 7 : 6);

    this.box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width,
      height,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      tags: true,
      keys: true,
      wrap: false,
      scrollable: true,
      alwaysScroll: true,
    });

    this.setupKeyHandlers();
    this.render();
  }

  private setupKeyHandlers(): void {
    this.box.key(['escape'], () => {
      this.destroy();
      this.onCancel();
    });

    this.box.key(['enter', 'space'], () => {
      this.confirm(this.selectedIndex);
    });

    this.box.key(['up', 'k'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.box.key(['down', 'j'], () => {
      this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
      this.render();
    });

    this.box.on('click', (_mouse: { y: number }) => {
      const contentY = _mouse.y - (this.box.atop as number) - 1; // subtract border
      const index = contentY - (this.parentLabel ? 3 : 2); // subtract header (+ parent) + blank
      if (index >= 0 && index < this.rows.length) {
        if (index === this.selectedIndex) {
          this.confirm(index); // second click on the selected item confirms
        } else {
          this.selectedIndex = index;
          this.render();
        }
      }
    });
  }

  private confirm(index: number): void {
    const row = this.rows[index];
    if (row) {
      this.destroy();
      this.onSelect(row.path);
    }
  }

  private render(): void {
    const inner = Math.max(8, (this.box.width as number) - 4);
    const lines: string[] = [];

    lines.push('{bold}{cyan-fg} Worktrees{/cyan-fg}{/bold}');
    if (this.parentLabel) {
      lines.push(`{gray-fg} ${truncate(this.parentLabel, inner - 1)}{/gray-fg}`);
    }
    lines.push('');

    if (this.rows.length === 0) {
      lines.push('{gray-fg} No worktrees{/gray-fg}');
    } else {
      this.rows.forEach((row, i) => {
        const isSelected = i === this.selectedIndex;
        const marker = isSelected ? '> ' : '  ';
        const suffix = row.isCurrent ? ' (current)' : '';
        const annPlain = row.annotation ? `  ${row.annotation}` : '';
        const nameBudget = inner - marker.length - annPlain.length - suffix.length;
        const name = truncate(row.name, nameBudget);

        let line = isSelected
          ? `{cyan-fg}{bold}${marker}${name}{/bold}{/cyan-fg}`
          : `${marker}${name}`;
        if (row.annotation) {
          const color = row.annotation.startsWith('→') ? 'yellow' : 'gray';
          line += `  {${color}-fg}${row.annotation}{/${color}-fg}`;
        }
        if (suffix) line += `{gray-fg}${suffix}{/gray-fg}`;
        lines.push(line);
      });
    }

    lines.push('');
    lines.push(`{gray-fg} ${truncate(FOOTER, inner - 1)}{/gray-fg}`);

    this.box.setContent(lines.join('\n'));
    this.screen.render();
  }

  destroy(): void {
    this.box.destroy();
  }

  focus(): void {
    this.box.focus();
  }
}
