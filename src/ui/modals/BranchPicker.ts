import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import type { LocalBranch } from '../../git/status.js';

/**
 * BranchPicker modal for switching or creating branches.
 * Text input at top for filtering; branch list below.
 * If typed name matches no existing branch, shows "Create: <name>" as first option.
 */
export class BranchPicker {
  private box: Widgets.BoxElement;
  private textbox: Widgets.TextareaElement;
  private screen: Widgets.Screen;
  private branches: LocalBranch[];
  private filteredBranches: LocalBranch[] = [];
  private selectedIndex: number = 0;
  private query: string = '';
  private showCreate: boolean = false;
  private onSwitch: (name: string) => void;
  private onCreate: (name: string) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    branches: LocalBranch[],
    onSwitch: (name: string) => void,
    onCreate: (name: string) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.branches = branches;
    this.onSwitch = onSwitch;
    this.onCreate = onCreate;
    this.onCancel = onCancel;

    this.filteredBranches = branches;

    const width = Math.min(60, (screen.width as number) - 6);
    const maxVisible = Math.min(branches.length + 1, 15);
    const height = maxVisible + 7;

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
      keys: false,
    });

    this.textbox = blessed.textarea({
      parent: this.box,
      top: 1,
      left: 1,
      width: width - 4,
      height: 1,
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    this.setupKeyHandlers();
    this.render();
  }

  private setupKeyHandlers(): void {
    this.textbox.key(['escape'], () => {
      this.close();
      this.onCancel();
    });

    this.textbox.key(['enter'], () => {
      if (this.showCreate && this.selectedIndex === 0) {
        this.close();
        this.onCreate(this.query.trim());
      } else {
        const adjustedIndex = this.showCreate ? this.selectedIndex - 1 : this.selectedIndex;
        const branch = this.filteredBranches[adjustedIndex];
        if (branch && !branch.current) {
          this.close();
          this.onSwitch(branch.name);
        }
      }
    });

    this.textbox.key(['C-j', 'down'], () => {
      const maxIndex = this.filteredBranches.length + (this.showCreate ? 1 : 0) - 1;
      this.selectedIndex = Math.min(maxIndex, this.selectedIndex + 1);
      this.render();
    });

    this.textbox.key(['C-k', 'up'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.textbox.on('keypress', () => {
      setImmediate(() => {
        const newQuery = this.textbox.getValue() || '';
        if (newQuery !== this.query) {
          this.query = newQuery;
          this.selectedIndex = 0;
          this.updateFilter();
          this.render();
        }
      });
    });
  }

  private updateFilter(): void {
    const q = this.query.trim().toLowerCase();
    if (!q) {
      this.filteredBranches = this.branches;
      this.showCreate = false;
    } else {
      this.filteredBranches = this.branches.filter((b) => b.name.toLowerCase().includes(q));
      // Show create option if no exact match
      this.showCreate = !this.branches.some((b) => b.name === q);
    }
  }

  private render(): void {
    const lines: string[] = [];

    lines.push('{bold}{cyan-fg}Switch / Create Branch{/cyan-fg}{/bold}');
    lines.push(''); // Space for input
    lines.push('');

    if (this.showCreate) {
      const isSelected = this.selectedIndex === 0;
      if (isSelected) {
        lines.push(`{green-fg}{bold}> Create: ${this.query.trim()}{/bold}{/green-fg}`);
      } else {
        lines.push(`  {green-fg}Create: ${this.query.trim()}{/green-fg}`);
      }
    }

    for (let i = 0; i < this.filteredBranches.length; i++) {
      const branch = this.filteredBranches[i];
      const listIndex = this.showCreate ? i + 1 : i;
      const isSelected = listIndex === this.selectedIndex;

      let line = isSelected ? '{cyan-fg}{bold}> ' : '  ';
      if (branch.current) {
        line += '* ';
      }
      line += branch.name;
      if (isSelected) line += '{/bold}{/cyan-fg}';
      if (branch.current) line += ' {gray-fg}(current){/gray-fg}';

      lines.push(line);
    }

    if (this.filteredBranches.length === 0 && !this.showCreate) {
      lines.push('{gray-fg}No matching branches{/gray-fg}');
    }

    lines.push('');
    lines.push('{gray-fg}Enter: select | Esc: cancel | Ctrl+j/k: navigate{/gray-fg}');

    this.box.setContent(lines.join('\n'));
    this.screen.render();
  }

  private close(): void {
    this.textbox.destroy();
    this.box.destroy();
  }

  focus(): void {
    this.textbox.focus();
  }
}
