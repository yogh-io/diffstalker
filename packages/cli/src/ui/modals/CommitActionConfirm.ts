import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import type { CommitInfo } from '../../git/status.js';
import type { Modal } from './Modal.js';

/**
 * CommitActionConfirm modal for confirming cherry-pick or revert.
 */
export class CommitActionConfirm implements Modal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private onConfirm: () => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    verb: string,
    commit: CommitInfo,
    onConfirm: () => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;

    const width = Math.min(60, (screen.width as number) - 6);
    const height = 8;

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
    this.renderContent(verb, commit, width);
  }

  private setupKeyHandlers(): void {
    this.box.key(['y', 'Y'], () => {
      this.destroy();
      this.onConfirm();
    });

    this.box.key(['n', 'N', 'escape'], () => {
      this.destroy();
      this.onCancel();
    });
  }

  private renderContent(verb: string, commit: CommitInfo, width: number): void {
    const lines: string[] = [];
    const innerWidth = width - 6;

    lines.push(`{bold}{yellow-fg}     ${verb} commit?{/yellow-fg}{/bold}`);
    lines.push('');

    const msg =
      commit.message.length > innerWidth
        ? commit.message.slice(0, innerWidth - 3) + '\u2026'
        : commit.message;
    lines.push(`{yellow-fg}${commit.shortHash}{/yellow-fg} ${msg}`);
    lines.push('');
    lines.push(
      '{gray-fg}Press {/gray-fg}{green-fg}y{/green-fg}{gray-fg} to confirm, {/gray-fg}{red-fg}n{/red-fg}{gray-fg} or Esc to cancel{/gray-fg}'
    );

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
