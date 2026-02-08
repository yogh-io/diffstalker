import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import type { Modal } from './Modal.js';

/**
 * BaseBranchPicker modal for selecting the base branch for PR comparison.
 */
export class BaseBranchPicker implements Modal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private branches: string[];
  private selectedIndex: number;
  private currentBranch: string | null;
  private onSelect: (branch: string) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    branches: string[],
    currentBranch: string | null,
    onSelect: (branch: string) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.branches = branches;
    this.currentBranch = currentBranch;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // Find current branch index
    this.selectedIndex = currentBranch ? branches.indexOf(currentBranch) : 0;
    if (this.selectedIndex < 0) this.selectedIndex = 0;

    // Create modal box
    const width = 50;
    const maxVisibleBranches = Math.min(branches.length, 15);
    const height = maxVisibleBranches + 6; // branches + header + footer + borders + padding

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

    // Setup key handlers
    this.setupKeyHandlers();

    // Initial render
    this.render();
  }

  private setupKeyHandlers(): void {
    this.box.key(['escape'], () => {
      this.destroy();
      this.onCancel();
    });

    this.box.key(['enter', 'space'], () => {
      const selected = this.branches[this.selectedIndex];
      if (selected) {
        this.destroy();
        this.onSelect(selected);
      }
    });

    this.box.key(['up', 'k'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.box.key(['down', 'j'], () => {
      this.selectedIndex = Math.min(this.branches.length - 1, this.selectedIndex + 1);
      this.render();
    });
  }

  private render(): void {
    const lines: string[] = [];

    // Header
    lines.push('{bold}{cyan-fg}     Select Base Branch{/cyan-fg}{/bold}');
    lines.push('');

    if (this.branches.length === 0) {
      lines.push('{gray-fg}No branches found{/gray-fg}');
    } else {
      // Branch list
      for (let i = 0; i < this.branches.length; i++) {
        const branch = this.branches[i];
        const isSelected = i === this.selectedIndex;
        const isCurrent = branch === this.currentBranch;

        let line = isSelected ? '{cyan-fg}{bold}> ' : '  ';
        line += branch;
        if (isSelected) line += '{/bold}{/cyan-fg}';
        if (isCurrent) line += ' {gray-fg}(current){/gray-fg}';

        lines.push(line);
      }
    }

    // Footer
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
