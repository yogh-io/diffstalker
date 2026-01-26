import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';

/**
 * Layout constants matching the React/Ink implementation.
 */
export const LAYOUT_OVERHEAD = 5; // Header (1-2) + 3 separators + footer (1)
export const SPLIT_RATIO_STEP = 0.05;

export interface LayoutDimensions {
  width: number;
  height: number;
  headerHeight: number;
  topPaneHeight: number;
  bottomPaneHeight: number;
  footerRow: number;
}

export interface PaneBoundaries {
  stagingPaneStart: number;
  fileListEnd: number;
  diffPaneStart: number;
  diffPaneEnd: number;
  footerRow: number;
}

/**
 * Calculate layout dimensions based on terminal size and split ratio.
 */
export function calculateLayout(
  terminalHeight: number,
  terminalWidth: number,
  splitRatio: number,
  headerHeight: number = 1
): LayoutDimensions {
  // Total overhead: header + 3 separators + footer
  const overhead = headerHeight + 4; // 3 separators + 1 footer
  const availableHeight = terminalHeight - overhead;

  const topPaneHeight = Math.floor(availableHeight * splitRatio);
  const bottomPaneHeight = availableHeight - topPaneHeight;

  return {
    width: terminalWidth,
    height: terminalHeight,
    headerHeight,
    topPaneHeight,
    bottomPaneHeight,
    footerRow: terminalHeight - 1,
  };
}

/**
 * Calculate pane boundaries for mouse click detection.
 */
export function calculatePaneBoundaries(
  terminalHeight: number,
  headerHeight: number,
  topPaneHeight: number,
  bottomPaneHeight: number
): PaneBoundaries {
  const stagingPaneStart = headerHeight + 1; // After header + separator
  const fileListEnd = stagingPaneStart + topPaneHeight;
  const diffPaneStart = fileListEnd + 1; // After separator
  const diffPaneEnd = diffPaneStart + bottomPaneHeight;
  const footerRow = terminalHeight - 1;

  return {
    stagingPaneStart,
    fileListEnd,
    diffPaneStart,
    diffPaneEnd,
    footerRow,
  };
}

/**
 * LayoutManager creates and manages blessed boxes for the two-pane layout.
 */
export class LayoutManager {
  public screen: Widgets.Screen;
  public headerBox: Widgets.BoxElement;
  public topSeparator: Widgets.BoxElement;
  public topPane: Widgets.BoxElement;
  public middleSeparator: Widgets.BoxElement;
  public bottomPane: Widgets.BoxElement;
  public bottomSeparator: Widgets.BoxElement;
  public footerBox: Widgets.BoxElement;

  private _dimensions: LayoutDimensions;
  private _splitRatio: number;

  constructor(screen: Widgets.Screen, splitRatio: number = 0.4) {
    this.screen = screen;
    this._splitRatio = splitRatio;
    this._dimensions = this.calculateDimensions();

    // Create all layout boxes
    this.headerBox = this.createHeaderBox();
    this.topSeparator = this.createSeparator(this._dimensions.headerHeight);
    this.topPane = this.createTopPane();
    this.middleSeparator = this.createSeparator(
      this._dimensions.headerHeight + 1 + this._dimensions.topPaneHeight
    );
    this.bottomPane = this.createBottomPane();
    this.bottomSeparator = this.createSeparator(
      this._dimensions.headerHeight +
        2 +
        this._dimensions.topPaneHeight +
        this._dimensions.bottomPaneHeight
    );
    this.footerBox = this.createFooterBox();

    // Handle screen resize
    screen.on('resize', () => this.onResize());
  }

  get dimensions(): LayoutDimensions {
    return this._dimensions;
  }

  get splitRatio(): number {
    return this._splitRatio;
  }

  setSplitRatio(ratio: number): void {
    this._splitRatio = Math.min(0.85, Math.max(0.15, ratio));
    this.updateLayout();
  }

  adjustSplitRatio(delta: number): void {
    this.setSplitRatio(this._splitRatio + delta);
  }

  private calculateDimensions(): LayoutDimensions {
    const height = (this.screen.height as number) || 24;
    const width = (this.screen.width as number) || 80;
    return calculateLayout(height, width, this._splitRatio);
  }

  private createHeaderBox(): Widgets.BoxElement {
    return blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: this._dimensions.headerHeight,
      tags: true,
    });
  }

  private createSeparator(top: number): Widgets.BoxElement {
    const width = (this.screen.width as number) || 80;
    return blessed.box({
      parent: this.screen,
      top,
      left: 0,
      width: '100%',
      height: 1,
      content: '\u2500'.repeat(width),
      style: {
        fg: 'gray',
      },
    });
  }

  private createTopPane(): Widgets.BoxElement {
    return blessed.box({
      parent: this.screen,
      top: this._dimensions.headerHeight + 1,
      left: 0,
      width: '100%',
      height: this._dimensions.topPaneHeight,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'gray',
        },
        style: {
          inverse: true,
        },
      },
    });
  }

  private createBottomPane(): Widgets.BoxElement {
    return blessed.box({
      parent: this.screen,
      top: this._dimensions.headerHeight + 2 + this._dimensions.topPaneHeight,
      left: 0,
      width: '100%',
      height: this._dimensions.bottomPaneHeight,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'gray',
        },
        style: {
          inverse: true,
        },
      },
    });
  }

  private createFooterBox(): Widgets.BoxElement {
    return blessed.box({
      parent: this.screen,
      top: this._dimensions.footerRow,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
    });
  }

  private onResize(): void {
    this._dimensions = this.calculateDimensions();
    this.updateLayout();
    this.screen.render();
  }

  private updateLayout(): void {
    this._dimensions = this.calculateDimensions();
    const width = (this.screen.width as number) || 80;

    // Update header
    this.headerBox.height = this._dimensions.headerHeight;

    // Update top separator
    this.topSeparator.top = this._dimensions.headerHeight;
    this.topSeparator.setContent('\u2500'.repeat(width));

    // Update top pane
    this.topPane.top = this._dimensions.headerHeight + 1;
    this.topPane.height = this._dimensions.topPaneHeight;

    // Update middle separator
    this.middleSeparator.top = this._dimensions.headerHeight + 1 + this._dimensions.topPaneHeight;
    this.middleSeparator.setContent('\u2500'.repeat(width));

    // Update bottom pane
    this.bottomPane.top = this._dimensions.headerHeight + 2 + this._dimensions.topPaneHeight;
    this.bottomPane.height = this._dimensions.bottomPaneHeight;

    // Update bottom separator
    this.bottomSeparator.top =
      this._dimensions.headerHeight +
      2 +
      this._dimensions.topPaneHeight +
      this._dimensions.bottomPaneHeight;
    this.bottomSeparator.setContent('\u2500'.repeat(width));

    // Update footer
    this.footerBox.top = this._dimensions.footerRow;
  }

  /**
   * Get pane boundaries for mouse click detection.
   */
  getPaneBoundaries(): PaneBoundaries {
    return calculatePaneBoundaries(
      this._dimensions.height,
      this._dimensions.headerHeight,
      this._dimensions.topPaneHeight,
      this._dimensions.bottomPaneHeight
    );
  }

  /**
   * Convert screen Y coordinate to content row within the top pane.
   * Returns the 0-based row index of the content, or -1 if outside the pane.
   */
  screenYToTopPaneRow(screenY: number): number {
    const paneTop = this._dimensions.headerHeight + 1; // header + separator
    const paneBottom = paneTop + this._dimensions.topPaneHeight;

    if (screenY < paneTop || screenY >= paneBottom) {
      return -1;
    }

    return screenY - paneTop;
  }

  /**
   * Convert screen Y coordinate to content row within the bottom pane.
   * Returns the 0-based row index of the content, or -1 if outside the pane.
   */
  screenYToBottomPaneRow(screenY: number): number {
    const paneTop = this._dimensions.headerHeight + 2 + this._dimensions.topPaneHeight; // header + 2 separators + top pane
    const paneBottom = paneTop + this._dimensions.bottomPaneHeight;

    if (screenY < paneTop || screenY >= paneBottom) {
      return -1;
    }

    return screenY - paneTop;
  }

  /**
   * Get the top position of the top pane (for reference).
   */
  get topPaneTop(): number {
    return this._dimensions.headerHeight + 1;
  }

  /**
   * Get the top position of the bottom pane (for reference).
   */
  get bottomPaneTop(): number {
    return this._dimensions.headerHeight + 2 + this._dimensions.topPaneHeight;
  }
}
