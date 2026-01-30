import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';

const MAX_RESULTS = 15;

/**
 * Simple fuzzy match scoring.
 * Returns -1 if no match, otherwise a score (higher is better).
 */
function fuzzyScore(query: string, target: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  // Must contain all query characters in order
  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;

  for (let i = 0; i < lowerTarget.length && queryIndex < lowerQuery.length; i++) {
    if (lowerTarget[i] === lowerQuery[queryIndex]) {
      // Bonus for consecutive matches
      if (lastMatchIndex === i - 1) {
        score += 10;
      }
      // Bonus for matching at start of word
      if (i === 0 || lowerTarget[i - 1] === '/' || lowerTarget[i - 1] === '.') {
        score += 5;
      }
      score += 1;
      lastMatchIndex = i;
      queryIndex++;
    }
  }

  // All query characters must match
  if (queryIndex < lowerQuery.length) {
    return -1;
  }

  // Bonus for shorter paths (more specific)
  score += Math.max(0, 50 - target.length);

  return score;
}

/**
 * Highlight matched characters in path.
 */
function highlightMatch(query: string, path: string): string {
  if (!query) return path;

  const lowerQuery = query.toLowerCase();
  const lowerPath = path.toLowerCase();
  let result = '';
  let queryIndex = 0;

  for (let i = 0; i < path.length; i++) {
    if (queryIndex < lowerQuery.length && lowerPath[i] === lowerQuery[queryIndex]) {
      result += `{yellow-fg}${path[i]}{/yellow-fg}`;
      queryIndex++;
    } else {
      result += path[i];
    }
  }

  return result;
}

interface SearchResult {
  path: string;
  score: number;
}

/**
 * FileFinder modal for fuzzy file search.
 */
export class FileFinder {
  private box: Widgets.BoxElement;
  private textbox: Widgets.TextareaElement;
  private screen: Widgets.Screen;
  private allPaths: string[];
  private results: SearchResult[] = [];
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
        this.onSelect(selected.path);
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
      // Show first N files when no query
      this.results = this.allPaths.slice(0, MAX_RESULTS).map((path) => ({ path, score: 0 }));
      return;
    }

    // Fuzzy match all paths
    const scored: SearchResult[] = [];
    for (const path of this.allPaths) {
      const score = fuzzyScore(this.query, path);
      if (score >= 0) {
        scored.push({ path, score });
      }
    }

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    // Take top results
    this.results = scored.slice(0, MAX_RESULTS);
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
        let displayPath = result.path;
        const maxLen = width - 4;
        if (displayPath.length > maxLen) {
          displayPath = '…' + displayPath.slice(-(maxLen - 1));
        }

        // Highlight matched characters
        const highlighted = highlightMatch(this.query, displayPath);

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
