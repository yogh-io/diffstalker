import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { ThemeName, themes, themeOrder, getTheme } from '../../themes.js';

/**
 * ThemePicker modal for selecting diff themes.
 */
export class ThemePicker {
  private box: Widgets.BoxElement;
  private screen: Widgets.Screen;
  private selectedIndex: number;
  private currentTheme: ThemeName;
  private onSelect: (theme: ThemeName) => void;
  private onCancel: () => void;

  constructor(
    screen: Widgets.Screen,
    currentTheme: ThemeName,
    onSelect: (theme: ThemeName) => void,
    onCancel: () => void
  ) {
    this.screen = screen;
    this.currentTheme = currentTheme;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    // Find current theme index
    this.selectedIndex = themeOrder.indexOf(currentTheme);
    if (this.selectedIndex < 0) this.selectedIndex = 0;

    // Create modal box
    const width = 50;
    const height = themeOrder.length + 12; // themes + header + preview + footer + borders + padding

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
    });

    // Setup key handlers
    this.setupKeyHandlers();

    // Initial render
    this.render();
  }

  private setupKeyHandlers(): void {
    this.box.key(['escape', 'q'], () => {
      this.close();
      this.onCancel();
    });

    this.box.key(['enter', 'space'], () => {
      const selected = themeOrder[this.selectedIndex];
      this.close();
      this.onSelect(selected);
    });

    this.box.key(['up', 'k'], () => {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    });

    this.box.key(['down', 'j'], () => {
      this.selectedIndex = Math.min(themeOrder.length - 1, this.selectedIndex + 1);
      this.render();
    });
  }

  private render(): void {
    const lines: string[] = [];

    // Header
    lines.push('{bold}{cyan-fg}       Select Theme{/cyan-fg}{/bold}');
    lines.push('');

    // Theme list
    for (let i = 0; i < themeOrder.length; i++) {
      const themeName = themeOrder[i];
      const theme = themes[themeName];
      const isSelected = i === this.selectedIndex;
      const isCurrent = themeName === this.currentTheme;

      let line = isSelected ? '{cyan-fg}{bold}> ' : '  ';
      line += theme.displayName;
      if (isSelected) line += '{/bold}{/cyan-fg}';
      if (isCurrent) line += ' {gray-fg}(current){/gray-fg}';

      lines.push(line);
    }

    // Preview section
    lines.push('');
    lines.push('{gray-fg}Preview:{/gray-fg}');

    const previewTheme = getTheme(themeOrder[this.selectedIndex]);
    // Simple preview - just show add/del colors
    lines.push(`  {green-fg}+ added line{/green-fg}`);
    lines.push(`  {red-fg}- deleted line{/red-fg}`);

    // Footer
    lines.push('');
    lines.push('{gray-fg}j/k: navigate | Enter: select | Esc: cancel{/gray-fg}');

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
