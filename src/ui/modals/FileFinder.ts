import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { Fzf, type FzfResultItem } from 'fzf';

const MAX_RESULTS = 15;

/**
 * Highlight matched characters in a display path using fzf position data.
 * The positions set refers to indices in the original full path,
 * so we need an offset when the display path is truncated.
 */
function highlightMatch(displayPath: string, positions: Set<number>, offset: number): string {
  let result = '';
  for (let i = 0; i < displayPath.length; i++) {
    if (positions.has(i + offset)) {
      result += `{yellow-fg}${displayPath[i]}{/yellow-fg}`;
    } else {
      result += displayPath[i];
    }
  }
  return result;
}

/**
 * FileFinder modal for fuzzy file search.
 */
export class FileFinder {
  private box: Widgets.BoxElement;
  private textbox: Widgets.TextareaElement;
  private screen: Widgets.Screen;
  private fzf: Fzf<string[]>;
  private allPaths: string[];
  private results: FzfResultItem<string>[] = [];
  private selectedIndex: number = 0;
  private query: string = '';
  private onSelect: (path: string) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    allPaths: string[],
    onSelect: (path: string) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.allPaths = allPaths;
    this.fzf = new Fzf(allPaths, { limit: MAX_RESULTS, forward: false });
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // Create modal box
    const width = Math.min(80, (screen.width as number) - 10);
    const height = MAX_RESULTS + 6; // results + input + header + borders + padding

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
      keys: false, // We'll handle keys ourselves
    });

    // Create text input
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

    // Setup key handlers
    this.setupKeyHandlers();

    // Initial render with all files
    this.updateResults();
    this.render();
  }

  private setupKeyHandlers(): void {
    // Handle escape to cancel
    this.textbox.key(['escape'], () => {
      this.close();
      this.onCancel();
    });

    // Handle enter to select
    this.textbox.key(['enter'], () => {
      if (this.results.length > 0) {
        const selected = this.results[this.selectedIndex];
        this.close();
        this.onSelect(selected.item);
      }
    });

    // Handle up/down for navigation (Ctrl+j/k since j/k are for typing)
    this.textbox.key(['C-j', 'down'], () => {
      this.selectedIndex = Math.min(this.results.length - 1, this.selectedIndex + 1);
      this.render();
    });

    this.textbox.key(['C-k', 'up'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    // Handle tab for next result
    this.textbox.key(['tab'], () => {
      this.selectedIndex = (this.selectedIndex + 1) % Math.max(1, this.results.length);
      this.render();
    });

    // Handle shift-tab for previous result
    this.textbox.key(['S-tab'], () => {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.results.length) % Math.max(1, this.results.length);
      this.render();
    });

    // Update results on keypress
    this.textbox.on('keypress', () => {
      // Defer to next tick to get updated value
      setImmediate(() => {
        const newQuery = this.textbox.getValue() || '';
        if (newQuery !== this.query) {
          this.query = newQuery;
          this.selectedIndex = 0;
          this.updateResults();
          this.render();
        }
      });
    });
  }

  private updateResults(): void {
    if (!this.query) {
      // fzf returns nothing for empty query, show first N files
      this.results = this.allPaths
        .slice(0, MAX_RESULTS)
        .map((item) => ({ item, positions: new Set<number>(), start: 0, end: 0, score: 0 }));
      return;
    }

    this.results = this.fzf.find(this.query);
  }

  private render(): void {
    const lines: string[] = [];
    const width = (this.box.width as number) - 4;

    // Header
    lines.push('{bold}{cyan-fg}Find File{/cyan-fg}{/bold}');
    lines.push(''); // Space for input
    lines.push('');

    // Results
    if (this.results.length === 0 && this.query) {
      lines.push('{gray-fg}No matches{/gray-fg}');
    } else {
      for (let i = 0; i < this.results.length; i++) {
        const result = this.results[i];
        const isSelected = i === this.selectedIndex;

        // Truncate path if needed
        const fullPath = result.item;
        const maxLen = width - 4;
        let displayPath = fullPath;
        let offset = 0;
        if (displayPath.length > maxLen) {
          offset = displayPath.length - (maxLen - 1);
          displayPath = '…' + displayPath.slice(offset);
          // Account for the '…' prefix: display index 0 is '…', actual content starts at 1
          offset = offset - 1;
        }

        // Highlight matched characters using fzf positions
        const highlighted = highlightMatch(displayPath, result.positions, offset);

        if (isSelected) {
          lines.push(`{cyan-fg}{bold}> ${highlighted}{/bold}{/cyan-fg}`);
        } else {
          lines.push(`  ${highlighted}`);
        }
      }
    }

    // Pad to fill space
    while (lines.length < MAX_RESULTS + 3) {
      lines.push('');
    }

    // Footer
    lines.push('{gray-fg}Enter: select | Esc: cancel | Ctrl+j/k or ↑↓: navigate{/gray-fg}');

    this.box.setContent(lines.join('\n'));
    this.screen.render();
  }

  private close(): void {
    this.textbox.destroy();
    this.box.destroy();
  }

  /**
   * Focus the modal input.
   */
  focus(): void {
    this.textbox.focus();
  }
}
