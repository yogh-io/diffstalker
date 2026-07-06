import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { abbreviateHomePath } from '../../config.js';
import type { WorktreeInfo } from '../../git/worktree.js';
import type { Modal } from './Modal.js';

/**
 * WorktreePicker modal for switching between the worktrees of the current
 * repository. Used both when opening a bare-repo container (which worktree?)
 * and as a switcher between sibling worktrees.
 */
export class WorktreePicker implements Modal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private worktrees: WorktreeInfo[];
  private selectedIndex: number;
  private currentPath: string;
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
    this.worktrees = worktrees;
    this.currentPath = currentPath;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // Start on the current worktree if it's in the list
    this.selectedIndex = worktrees.findIndex((w) => w.path === currentPath);
    if (this.selectedIndex < 0) this.selectedIndex = 0;

    const screenWidth = screen.width as number;
    const width = Math.min(80, screenWidth - 4);
    const maxVisible = Math.min(worktrees.length, 15);
    const height = maxVisible + 6; // worktrees + header + footer + borders + padding

    this.box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width,
      height,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
      },
      tags: true,
      keys: true,
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
      this.selectedIndex = Math.min(this.worktrees.length - 1, this.selectedIndex + 1);
      this.render();
    });

    this.box.on('click', (_mouse: { y: number }) => {
      const contentY = _mouse.y - (this.box.atop as number) - 1; // subtract border
      const index = contentY - 2; // subtract header + blank line
      if (index >= 0 && index < this.worktrees.length) {
        if (index === this.selectedIndex) {
          // Second click on already-selected item: confirm
          this.confirm(index);
        } else {
          this.selectedIndex = index;
          this.render();
        }
      }
    });
  }

  private confirm(index: number): void {
    const selected = this.worktrees[index];
    if (selected) {
      this.destroy();
      this.onSelect(selected.path);
    }
  }

  private render(): void {
    const lines: string[] = [];

    lines.push('{bold}{cyan-fg}     Worktrees{/cyan-fg}{/bold}');
    lines.push('');

    if (this.worktrees.length === 0) {
      lines.push('{gray-fg}No worktrees{/gray-fg}');
    } else {
      const branchWidth = Math.min(
        24,
        Math.max(...this.worktrees.map((w) => (w.branch ?? '(detached)').length))
      );

      for (let i = 0; i < this.worktrees.length; i++) {
        const wt = this.worktrees[i];
        const isSelected = i === this.selectedIndex;
        const isCurrent = wt.path === this.currentPath;
        const branch = (wt.branch ?? '(detached)').padEnd(branchWidth);

        let line = isSelected ? '{cyan-fg}{bold}> ' : '  ';
        line += `{yellow-fg}${branch}{/yellow-fg}  ${abbreviateHomePath(wt.path)}`;
        if (isSelected) line += '{/bold}{/cyan-fg}';
        if (isCurrent) line += ' {gray-fg}(current){/gray-fg}';

        lines.push(line);
      }
    }

    lines.push('');
    lines.push('{gray-fg}j/k: navigate | Enter: select | Esc: cancel{/gray-fg}');

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
