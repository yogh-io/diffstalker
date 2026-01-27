import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';

/**
 * DiscardConfirm modal for confirming discard of file changes.
 */
export class DiscardConfirm {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private filePath: string;
  private onConfirm: () => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    filePath: string,
    onConfirm: () => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.filePath = filePath;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;

    // Create modal box - small confirmation dialog
    const width = Math.min(60, Math.max(40, filePath.length + 20));
    const height = 7;

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
          fg: 'yellow',
        },
      },
      tags: true,
      keys: true,
    });

    // Setup key handlers
    this.setupKeyHandlers();

    // Render content
    this.render();
  }

  private setupKeyHandlers(): void {
    this.box.key(['y', 'Y'], () => {
      this.close();
      this.onConfirm();
    });

    this.box.key(['n', 'N', 'escape', 'q'], () => {
      this.close();
      this.onCancel();
    });
  }

  private render(): void {
    const lines: string[] = [];

    // Header
    lines.push('{bold}{yellow-fg}     Discard Changes?{/yellow-fg}{/bold}');
    lines.push('');

    // File path (truncate if needed)
    const maxPathLen = (this.box.width as number) - 6;
    const displayPath =
      this.filePath.length > maxPathLen
        ? '...' + this.filePath.slice(-(maxPathLen - 3))
        : this.filePath;
    lines.push(`{white-fg}${displayPath}{/white-fg}`);
    lines.push('');

    // Prompt
    lines.push(
      '{gray-fg}Press {/gray-fg}{green-fg}y{/green-fg}{gray-fg} to confirm, {/gray-fg}{red-fg}n{/red-fg}{gray-fg} or Esc to cancel{/gray-fg}'
    );

    this.box.setContent(lines.join('\n'));
    this.screen.render();
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
