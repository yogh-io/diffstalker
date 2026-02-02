import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import type { CommitInfo } from '../../git/status.js';

/**
 * SoftResetConfirm modal for confirming soft reset HEAD~1.
 */
export class SoftResetConfirm {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private onConfirm: () => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    headCommit: CommitInfo,
    onConfirm: () => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;

    const width = Math.min(60, (screen.width as number) - 6);
    const height = 9;

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

    this.setupKeyHandlers();
    this.renderContent(headCommit, width);
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

  private renderContent(commit: CommitInfo, width: number): void {
    const lines: string[] = [];
    const innerWidth = width - 6;

    lines.push('{bold}{yellow-fg}     Soft Reset HEAD~1?{/yellow-fg}{/bold}');
    lines.push('');

    const msg =
      commit.message.length > innerWidth
        ? commit.message.slice(0, innerWidth - 3) + '\u2026'
        : commit.message;
    lines.push(`{yellow-fg}${commit.shortHash}{/yellow-fg} ${msg}`);
    lines.push('');
    lines.push('{gray-fg}Changes will return to staged state{/gray-fg}');
    lines.push('');
    lines.push(
      '{gray-fg}Press {/gray-fg}{green-fg}y{/green-fg}{gray-fg} to confirm, {/gray-fg}{red-fg}n{/red-fg}{gray-fg} or Esc to cancel{/gray-fg}'
    );

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
