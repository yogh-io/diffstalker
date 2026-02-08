import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { abbreviateHomePath } from '../../config.js';
import type { Modal } from './Modal.js';

/**
 * RepoPicker modal for switching between recently-visited repositories.
 */
export class RepoPicker implements Modal {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private repos: string[];
  private selectedIndex: number;
  private currentRepo: string;
  private onSelect: (repoPath: string) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    repos: string[],
    currentRepo: string,
    onSelect: (repoPath: string) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.repos = repos;
    this.currentRepo = currentRepo;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // Find current repo index
    this.selectedIndex = repos.indexOf(currentRepo);
    if (this.selectedIndex < 0) this.selectedIndex = 0;

    // Create modal box
    const screenWidth = screen.width as number;
    const width = Math.min(70, screenWidth - 4);
    const maxVisibleRepos = Math.min(repos.length, 15);
    const height = maxVisibleRepos + 6; // repos + header + footer + borders + padding

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

    // Initial render
    this.render();
  }

  private setupKeyHandlers(): void {
    this.box.key(['escape'], () => {
      this.destroy();
      this.onCancel();
    });

    this.box.key(['enter', 'space'], () => {
      const selected = this.repos[this.selectedIndex];
      if (selected) {
        this.destroy();
        this.onSelect(selected);
      }
    });

    this.box.key(['up', 'k'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.box.key(['down', 'j'], () => {
      this.selectedIndex = Math.min(this.repos.length - 1, this.selectedIndex + 1);
      this.render();
    });
  }

  private render(): void {
    const lines: string[] = [];

    // Header
    lines.push('{bold}{cyan-fg}     Recent Repositories{/cyan-fg}{/bold}');
    lines.push('');

    if (this.repos.length === 0) {
      lines.push('{gray-fg}No recent repositories{/gray-fg}');
    } else {
      // Repo list
      for (let i = 0; i < this.repos.length; i++) {
        const repo = this.repos[i];
        const isSelected = i === this.selectedIndex;
        const isCurrent = repo === this.currentRepo;

        let line = isSelected ? '{cyan-fg}{bold}> ' : '  ';
        line += abbreviateHomePath(repo);
        if (isSelected) line += '{/bold}{/cyan-fg}';
        if (isCurrent) line += ' {gray-fg}(current){/gray-fg}';

        lines.push(line);
      }
    }

    // Footer
    lines.push('');
    lines.push('{gray-fg}j/k: navigate | Enter: select | Esc: cancel{/gray-fg}');

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
