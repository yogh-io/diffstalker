import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';

interface HotkeyEntry {
  key: string;
  description: string;
}

interface HotkeyGroup {
  title: string;
  entries: HotkeyEntry[];
}

const hotkeyGroups: HotkeyGroup[] = [
  {
    title: 'Navigation',
    entries: [
      { key: 'j/k', description: 'Move up/down' },
      { key: 'Tab', description: 'Toggle pane focus' },
    ],
  },
  {
    title: 'Staging',
    entries: [
      { key: 's', description: 'Stage file' },
      { key: 'U', description: 'Unstage file' },
      { key: 'A', description: 'Stage all' },
      { key: 'Z', description: 'Unstage all' },
      { key: 'Space', description: 'Toggle stage' },
    ],
  },
  {
    title: 'Actions',
    entries: [
      { key: 'c', description: 'Commit panel' },
      { key: 'r', description: 'Refresh' },
      { key: 'q', description: 'Quit' },
    ],
  },
  {
    title: 'Resize',
    entries: [
      { key: '-', description: 'Shrink top pane' },
      { key: '+', description: 'Grow top pane' },
    ],
  },
  {
    title: 'Tabs',
    entries: [
      { key: '1', description: 'Diff view' },
      { key: '2', description: 'Commit panel' },
      { key: '3', description: 'History view' },
      { key: '4', description: 'Compare view' },
      { key: '5', description: 'Explorer view' },
    ],
  },
  {
    title: 'Toggles',
    entries: [
      { key: 'm', description: 'Mouse mode' },
      { key: 'w', description: 'Wrap mode' },
      { key: 'f', description: 'Follow mode' },
      { key: 't', description: 'Theme picker' },
      { key: '?', description: 'This help' },
    ],
  },
  {
    title: 'Explorer',
    entries: [
      { key: 'Enter', description: 'Enter directory' },
      { key: 'Backspace', description: 'Go up' },
      { key: '/', description: 'Find file' },
      { key: 'Ctrl+P', description: 'Find file (any tab)' },
      { key: 'g', description: 'Show changes only' },
    ],
  },
  {
    title: 'Compare',
    entries: [
      { key: 'b', description: 'Base branch picker' },
      { key: 'u', description: 'Toggle uncommitted' },
    ],
  },
  {
    title: 'Diff (pane focus)',
    entries: [
      { key: 'n', description: 'Next hunk' },
      { key: 'N', description: 'Previous hunk' },
      { key: 's', description: 'Toggle hunk staged/unstaged' },
      { key: 'd', description: 'Discard changes' },
    ],
  },
];

/**
 * HotkeysModal shows available keyboard shortcuts.
 */
export class HotkeysModal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private onClose: () => void;

  constructor(screen: Widgets.Screen, onClose: () => void) {
    this.screen = screen;
    this.onClose = onClose;

    // Calculate modal dimensions
    const screenWidth = screen.width as number;
    const screenHeight = screen.height as number;

    // Determine layout based on screen width
    const useTwoColumns = screenWidth >= 90;
    const width = useTwoColumns ? Math.min(80, screenWidth - 4) : Math.min(42, screenWidth - 4);
    const height = Math.min(this.calculateHeight(useTwoColumns), screenHeight - 4);

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

    // Render content
    this.render(useTwoColumns, width);
  }

  private calculateHeight(useTwoColumns: boolean): number {
    if (useTwoColumns) {
      const midpoint = Math.ceil(hotkeyGroups.length / 2);
      const leftGroups = hotkeyGroups.slice(0, midpoint);
      const rightGroups = hotkeyGroups.slice(midpoint);
      const leftLines = leftGroups.reduce((sum, g) => sum + g.entries.length + 2, 0);
      const rightLines = rightGroups.reduce((sum, g) => sum + g.entries.length + 2, 0);
      return Math.max(leftLines, rightLines) + 5;
    } else {
      return hotkeyGroups.reduce((sum, g) => sum + g.entries.length + 2, 0) + 5;
    }
  }

  private setupKeyHandlers(): void {
    this.box.key(['escape', 'enter', '?', 'q'], () => {
      this.close();
      this.onClose();
    });

    // Close on click anywhere
    this.box.on('click', () => {
      this.close();
      this.onClose();
    });
  }

  /**
   * Calculate the visible width of a string (excluding blessed tags).
   */
  private visibleWidth(str: string): number {
    return str.replace(/\{[^}]+\}/g, '').length;
  }

  /**
   * Pad a string with blessed tags to a visible width.
   */
  private padToVisible(str: string, targetWidth: number): string {
    const visible = this.visibleWidth(str);
    const padding = Math.max(0, targetWidth - visible);
    return str + ' '.repeat(padding);
  }

  private render(useTwoColumns: boolean, width: number): void {
    const lines: string[] = [];

    // Header
    lines.push('{bold}{cyan-fg}     Keyboard Shortcuts{/cyan-fg}{/bold}');
    lines.push('');

    if (useTwoColumns) {
      const midpoint = Math.ceil(hotkeyGroups.length / 2);
      const leftGroups = hotkeyGroups.slice(0, midpoint);
      const rightGroups = hotkeyGroups.slice(midpoint);
      const colWidth = Math.floor((width - 6) / 2);

      // Render side by side
      const leftLines = this.renderGroups(leftGroups, colWidth);
      const rightLines = this.renderGroups(rightGroups, colWidth);

      const maxLines = Math.max(leftLines.length, rightLines.length);
      for (let i = 0; i < maxLines; i++) {
        const left = this.padToVisible(leftLines[i] || '', colWidth);
        const right = rightLines[i] || '';
        lines.push(left + '  ' + right);
      }
    } else {
      // Single column
      for (const group of hotkeyGroups) {
        lines.push(`{bold}{gray-fg}${group.title}{/gray-fg}{/bold}`);
        for (const entry of group.entries) {
          lines.push(`  {cyan-fg}${entry.key.padEnd(10)}{/cyan-fg} ${entry.description}`);
        }
        lines.push('');
      }
    }

    // Footer
    lines.push('');
    lines.push('{gray-fg}Press Esc, Enter, or ? to close{/gray-fg}');

    this.box.setContent(lines.join('\n'));
    this.screen.render();
  }

  private renderGroups(groups: HotkeyGroup[], _colWidth: number): string[] {
    const lines: string[] = [];
    for (const group of groups) {
      lines.push(`{bold}{gray-fg}${group.title}{/gray-fg}{/bold}`);
      for (const entry of group.entries) {
        lines.push(`  {cyan-fg}${entry.key.padEnd(10)}{/cyan-fg} ${entry.description}`);
      }
      lines.push('');
    }
    return lines;
  }

  private close(): void {
    this.box.destroy();
  }

  /**
   * Focus the modal.
   */
  focus(): void {
    this.box.focus();
  }
}
