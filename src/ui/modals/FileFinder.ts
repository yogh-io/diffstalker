import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';

const MAX_RESULTS = 15;
const DEBOUNCE_MS = 15;

interface MatchResult {
  path: string;
  score: number;
  positions: Set<number>;
}

/**
 * Fuzzy subsequence match: checks if all characters in `query` appear
 * in `target` in order. Returns match positions and a score, or null if no match.
 */
function subsequenceMatch(query: string, target: string): MatchResult | null {
  const lowerQuery = query.toLowerCase();
  const lowerTarget = target.toLowerCase();

  // Quick check: all query chars must exist somewhere
  let qi = 0;
  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) qi++;
  }
  if (qi < lowerQuery.length) return null;

  // Score the match
  const positions = new Set<number>();
  let score = 0;
  qi = 0;
  let lastMatchIndex = -1;

  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) {
      positions.add(ti);

      // Consecutive match bonus
      if (lastMatchIndex === ti - 1) {
        score += 5;
      }

      // Match after separator (/ or .) — start of path segment
      if (ti === 0 || target[ti - 1] === '/' || target[ti - 1] === '.') {
        score += 3;
      }

      // Match at start of filename (after last /)
      const lastSlash = target.lastIndexOf('/', ti - 1);
      if (ti === lastSlash + 1) {
        score += 2;
      }

      // Prefer matches later in the path (filename over directory)
      score += ti / target.length;

      lastMatchIndex = ti;
      qi++;
    }
  }

  // Penalize longer paths (prefer shorter, more specific matches)
  score -= target.length * 0.01;

  return { path: target, score, positions };
}

/**
 * Highlight matched characters in a display path.
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
  private allPaths: string[];
  private results: MatchResult[] = [];
  private selectedIndex: number = 0;
  private query: string = '';
  private onSelect: (path: string) => void;
  private onCancel: () => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

    // Initial render with first N files
    this.updateResults();
    this.renderContent();
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
      this.renderContent();
    });

    this.textbox.key(['C-k', 'up'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.renderContent();
    });

    // Handle tab for next result
    this.textbox.key(['tab'], () => {
      this.selectedIndex = (this.selectedIndex + 1) % Math.max(1, this.results.length);
      this.renderContent();
    });

    // Handle shift-tab for previous result
    this.textbox.key(['S-tab'], () => {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.results.length) % Math.max(1, this.results.length);
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
      }, DEBOUNCE_MS);
    });
  }

  private updateResults(): void {
    if (!this.query) {
      // Show first N files for empty query
      this.results = this.allPaths
        .slice(0, MAX_RESULTS)
        .map((p) => ({ path: p, positions: new Set<number>(), score: 0 }));
      return;
    }

    const matches: MatchResult[] = [];
    for (const p of this.allPaths) {
      const match = subsequenceMatch(this.query, p);
      if (match) {
        matches.push(match);
        // Collect more than needed so we can sort, but cap to avoid scoring thousands
        if (matches.length >= MAX_RESULTS * 10) break;
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);
    this.results = matches.slice(0, MAX_RESULTS);
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
        const result = this.results[i];
        const isSelected = i === this.selectedIndex;

        // Truncate path if needed
        const fullPath = result.path;
        const maxLen = width - 4;
        let displayPath = fullPath;
        let offset = 0;
        if (displayPath.length > maxLen) {
          offset = displayPath.length - (maxLen - 1);
          displayPath = '…' + displayPath.slice(offset);
          // Account for the '…' prefix: display index 0 is '…', actual content starts at 1
          offset = offset - 1;
        }

        // Highlight matched characters
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
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
