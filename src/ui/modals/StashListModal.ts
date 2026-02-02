import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import type { StashEntry } from '../../git/status.js';

/**
 * StashListModal shows stash entries and allows popping one.
 */
export class StashListModal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private entries: StashEntry[];
  private selectedIndex: number = 0;
  private onPop: (index: number) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    entries: StashEntry[],
    onPop: (index: number) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.entries = entries;
    this.onPop = onPop;
    this.onCancel = onCancel;

    // Create modal box
    const width = Math.min(70, (screen.width as number) - 6);
    const maxVisible = Math.min(entries.length, 15);
    const height = maxVisible + 6;

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
    this.box.key(['escape', 'q'], () => {
      this.close();
      this.onCancel();
    });

    this.box.key(['enter'], () => {
      if (this.entries.length > 0) {
        const index = this.entries[this.selectedIndex].index;
        this.close();
        this.onPop(index);
      }
    });

    this.box.key(['up', 'k'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.box.key(['down', 'j'], () => {
      this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
      this.render();
    });
  }

  private render(): void {
    const lines: string[] = [];
    const width = (this.box.width as number) - 4;

    lines.push('{bold}{cyan-fg}     Stash List{/cyan-fg}{/bold}');
    lines.push('');

    if (this.entries.length === 0) {
      lines.push('{gray-fg}No stash entries{/gray-fg}');
    } else {
      for (let i = 0; i < this.entries.length; i++) {
        const entry = this.entries[i];
        const isSelected = i === this.selectedIndex;
        const msg =
          entry.message.length > width - 10
            ? entry.message.slice(0, width - 13) + '\u2026'
            : entry.message;

        if (isSelected) {
          lines.push(`{cyan-fg}{bold}> {${i}} ${msg}{/bold}{/cyan-fg}`);
        } else {
          lines.push(`  {gray-fg}{${i}}{/gray-fg} ${msg}`);
        }
      }
    }

    lines.push('');
    lines.push('{gray-fg}j/k: navigate | Enter: pop | Esc: cancel{/gray-fg}');

    this.box.setContent(lines.join('\n'));
    this.screen.render();
  }

  private close(): void {
    this.box.destroy();
  }

  focus(): void {
    this.box.focus();
  }
}
