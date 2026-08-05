import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import {
  clampMove,
  createFinderIndex,
  cycleMove,
  toSegments,
  FINDER_DEBOUNCE_MS,
  type FinderIndex,
  type FinderMatch,
} from '@diffstalker/core/view/finderModel';
import type { Modal } from './Modal.js';

const MAX_RESULTS = 15;

/**
 * Highlight matched characters in a display path.
 *
 * `positions` indexes the FULL path; `sliceFrom` is where the rendered
 * tail starts in it. The box is `tags: true`, so path text has to be
 * escaped — a repo file named `a{bold}b` would otherwise be read as
 * markup and corrupt the modal.
 */
function highlightMatch(tail: string, positions: ReadonlySet<number>, sliceFrom: number): string {
  return toSegments(tail, positions, sliceFrom)
    .map((segment) => {
      const text = blessed.escape(segment.text);
      return segment.hit ? `{yellow-fg}${text}{/yellow-fg}` : text;
    })
    .join('');
}

/**
 * One result row: left-truncated to `width`, matches highlighted, and
 * marked up for selection.
 */
function formatRow(match: FinderMatch, selected: boolean, width: number): string {
  const maxLen = width - 4;
  // Truncate from the left: the filename end is the informative part. The
  // ellipsis is rendered here, outside the highlighter, so the positions
  // stay aligned to the untruncated path.
  const sliceFrom = match.text.length > maxLen ? match.text.length - (maxLen - 1) : 0;
  const ellipsis = sliceFrom > 0 ? '…' : '';
  const body = ellipsis + highlightMatch(match.text.slice(sliceFrom), match.positions, sliceFrom);
  return selected ? `{cyan-fg}{bold}> ${body}{/bold}{/cyan-fg}` : `  ${body}`;
}

/**
 * FileFinder modal for fuzzy file search.
 */
export class FileFinder implements Modal {
  private box: Widgets.BoxElement;
  private textbox: Widgets.TextareaElement;
  private screen: Widgets.Screen;
  private results: FinderMatch[] = [];
  private selectedIndex: number = 0;
  private query: string = '';
  private onSelect: (path: string) => void;
  private onCancel: () => void;
  private onQuit: () => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private finderIndex: FinderIndex;

  constructor(
    screen: Widgets.Screen,
    allPaths: string[],
    onSelect: (path: string) => void,
    onCancel: () => void,
    onQuit: () => void
  ) {
    this.screen = screen;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.onQuit = onQuit;
    this.finderIndex = createFinderIndex(allPaths, MAX_RESULTS);

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

    // Initial render with first N files
    this.updateResults();
    this.renderContent();
  }

  private setupKeyHandlers(): void {
    // Handle escape to cancel
    this.textbox.key(['escape'], () => {
      this.destroy();
      this.onCancel();
    });

    // Ctrl+C must quit from here too. blessed's grabKeys suppresses the
    // screen-level handler while this textarea has focus, and the textarea
    // swallows control characters — so without this binding the finder is
    // the one place in the app where the universal exit does nothing.
    this.textbox.key(['C-c'], () => {
      this.destroy();
      this.onQuit();
    });

    // Handle enter to select
    this.textbox.key(['enter'], () => {
      if (this.results.length > 0) {
        const selected = this.results[this.selectedIndex];
        this.destroy();
        this.onSelect(selected.text);
      }
    });

    // Handle up/down for navigation (Ctrl+j/k since j/k are for typing)
    this.textbox.key(['C-j', 'down'], () => {
      this.selectedIndex = clampMove(this.selectedIndex, 1, this.results.length);
      this.renderContent();
    });

    this.textbox.key(['C-k', 'up'], () => {
      this.selectedIndex = clampMove(this.selectedIndex, -1, this.results.length);
      this.renderContent();
    });

    // Handle tab for next result
    this.textbox.key(['tab'], () => {
      this.selectedIndex = cycleMove(this.selectedIndex, 1, this.results.length);
      this.renderContent();
    });

    // Handle shift-tab for previous result
    this.textbox.key(['S-tab'], () => {
      this.selectedIndex = cycleMove(this.selectedIndex, -1, this.results.length);
      this.renderContent();
    });

    // Update results on keypress with debounce
    this.textbox.on('keypress', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const newQuery = this.textbox.getValue() || '';
        if (newQuery !== this.query) {
          this.query = newQuery;
          this.selectedIndex = 0;
          this.updateResults();
          this.renderContent();
        }
      }, FINDER_DEBOUNCE_MS);
    });
  }

  private updateResults(): void {
    this.results = this.finderIndex.find(this.query);
  }

  private renderContent(): void {
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
        lines.push(formatRow(this.results[i], i === this.selectedIndex, width));
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

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.textbox.destroy();
    this.box.destroy();
  }

  focus(): void {
    this.textbox.focus();
  }
}
