import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { getIgnoredFiles } from '../git/ignoreUtils.js';

export interface ExplorerItem {
  name: string;
  path: string; // relative to repo root
  isDirectory: boolean;
}

export interface SelectedFile {
  path: string;
  content: string;
  truncated?: boolean;
}

export interface ExplorerState {
  currentPath: string;
  items: ExplorerItem[];
  selectedIndex: number;
  selectedFile: SelectedFile | null;
  isLoading: boolean;
  error: string | null;
}

export interface ExplorerOptions {
  hideHidden: boolean;
  hideGitignored: boolean;
}

type ExplorerStateEventMap = {
  'state-change': [ExplorerState];
};

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const WARN_FILE_SIZE = 100 * 1024; // 100KB

/**
 * Check if content appears to be binary.
 */
function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (common in binary files)
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * ExplorerStateManager manages file explorer state independent of React.
 * It handles directory loading, file selection, and navigation.
 */
export class ExplorerStateManager extends EventEmitter<ExplorerStateEventMap> {
  private repoPath: string;
  private options: ExplorerOptions;

  private _state: ExplorerState = {
    currentPath: '',
    items: [],
    selectedIndex: 0,
    selectedFile: null,
    isLoading: false,
    error: null,
  };

  constructor(repoPath: string, options: ExplorerOptions) {
    super();
    this.repoPath = repoPath;
    this.options = options;
  }

  get state(): ExplorerState {
    return this._state;
  }

  private updateState(partial: Partial<ExplorerState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state-change', this._state);
  }

  /**
   * Set filtering options and reload directory.
   */
  async setOptions(options: Partial<ExplorerOptions>): Promise<void> {
    this.options = { ...this.options, ...options };
    await this.loadDirectory(this._state.currentPath);
  }

  /**
   * Load a directory's contents.
   */
  async loadDirectory(relativePath: string): Promise<void> {
    this.updateState({ isLoading: true, error: null, currentPath: relativePath });

    try {
      const fullPath = path.join(this.repoPath, relativePath);
      const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

      // Build list of paths for gitignore check
      const pathsToCheck = entries.map((e) =>
        relativePath ? path.join(relativePath, e.name) : e.name
      );

      // Get ignored files (only if we need to filter them)
      const ignoredFiles = this.options.hideGitignored
        ? await getIgnoredFiles(this.repoPath, pathsToCheck)
        : new Set<string>();

      // Filter and map entries
      const explorerItems: ExplorerItem[] = entries
        .filter((entry) => {
          // Filter dot-prefixed hidden files
          if (this.options.hideHidden && entry.name.startsWith('.')) {
            return false;
          }

          // Filter gitignored files
          if (this.options.hideGitignored) {
            const entryPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
            if (ignoredFiles.has(entryPath)) {
              return false;
            }
          }

          return true;
        })
        .map((entry) => ({
          name: entry.name,
          path: relativePath ? path.join(relativePath, entry.name) : entry.name,
          isDirectory: entry.isDirectory(),
        }));

      // Sort: directories first (alphabetical), then files (alphabetical)
      explorerItems.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Add ".." at the beginning if not at root
      if (relativePath) {
        explorerItems.unshift({
          name: '..',
          path: path.dirname(relativePath) || '',
          isDirectory: true,
        });
      }

      this.updateState({
        items: explorerItems,
        selectedIndex: 0,
        selectedFile: null,
        isLoading: false,
      });
    } catch (err) {
      this.updateState({
        error: err instanceof Error ? err.message : 'Failed to read directory',
        items: [],
        isLoading: false,
      });
    }
  }

  /**
   * Load a file's contents.
   */
  async loadFile(itemPath: string): Promise<void> {
    try {
      const fullPath = path.join(this.repoPath, itemPath);
      const stats = await fs.promises.stat(fullPath);

      // Check file size
      if (stats.size > MAX_FILE_SIZE) {
        this.updateState({
          selectedFile: {
            path: itemPath,
            content: `File too large to display (${(stats.size / 1024 / 1024).toFixed(2)} MB).\nMaximum size: 1 MB`,
            truncated: true,
          },
        });
        return;
      }

      const buffer = await fs.promises.readFile(fullPath);

      // Check if binary
      if (isBinaryContent(buffer)) {
        this.updateState({
          selectedFile: {
            path: itemPath,
            content: 'Binary file - cannot display',
          },
        });
        return;
      }

      let content = buffer.toString('utf-8');
      let truncated = false;

      // Warn about large files
      if (stats.size > WARN_FILE_SIZE) {
        const warning = `⚠ Large file (${(stats.size / 1024).toFixed(1)} KB)\n\n`;
        content = warning + content;
      }

      // Truncate if needed
      const maxLines = 5000;
      const lines = content.split('\n');
      if (lines.length > maxLines) {
        content =
          lines.slice(0, maxLines).join('\n') +
          `\n\n... (truncated, ${lines.length - maxLines} more lines)`;
        truncated = true;
      }

      this.updateState({
        selectedFile: {
          path: itemPath,
          content,
          truncated,
        },
      });
    } catch (err) {
      this.updateState({
        selectedFile: {
          path: itemPath,
          content: err instanceof Error ? `Error: ${err.message}` : 'Failed to read file',
        },
      });
    }
  }

  /**
   * Select an item by index.
   */
  async selectIndex(index: number): Promise<void> {
    if (index < 0 || index >= this._state.items.length) return;

    const selected = this._state.items[index];
    this.updateState({ selectedIndex: index });

    if (selected && !selected.isDirectory) {
      await this.loadFile(selected.path);
    } else {
      this.updateState({ selectedFile: null });
    }
  }

  /**
   * Navigate to previous item.
   * Returns the new scroll offset if scrolling is needed, or null if not.
   */
  navigateUp(currentScrollOffset: number): number | null {
    const newIndex = Math.max(0, this._state.selectedIndex - 1);
    if (newIndex === this._state.selectedIndex) return null;

    // Don't await - fire and forget for responsiveness
    this.selectIndex(newIndex);

    // Return new scroll offset if we need to scroll up
    if (newIndex < currentScrollOffset) {
      return newIndex;
    }
    return null;
  }

  /**
   * Navigate to next item.
   * Returns the new scroll offset if scrolling is needed, or null if not.
   */
  navigateDown(currentScrollOffset: number, visibleHeight: number): number | null {
    const newIndex = Math.min(this._state.items.length - 1, this._state.selectedIndex + 1);
    if (newIndex === this._state.selectedIndex) return null;

    // Don't await - fire and forget for responsiveness
    this.selectIndex(newIndex);

    // Calculate visible area accounting for scroll indicators
    const needsScrolling = this._state.items.length > visibleHeight;
    const availableHeight = needsScrolling ? visibleHeight - 2 : visibleHeight;
    const visibleEnd = currentScrollOffset + availableHeight;

    if (newIndex >= visibleEnd) {
      return currentScrollOffset + 1;
    }
    return null;
  }

  /**
   * Enter the selected directory or go to parent if ".." is selected.
   */
  async enterDirectory(): Promise<void> {
    const selected = this._state.items[this._state.selectedIndex];
    if (!selected) return;

    if (selected.isDirectory) {
      if (selected.name === '..') {
        await this.loadDirectory(path.dirname(this._state.currentPath) || '');
      } else {
        await this.loadDirectory(selected.path);
      }
    }
    // If it's a file, do nothing (file content is already shown)
  }

  /**
   * Go to parent directory (backspace navigation).
   */
  async goUp(): Promise<void> {
    if (this._state.currentPath) {
      await this.loadDirectory(path.dirname(this._state.currentPath) || '');
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.removeAllListeners();
  }
}
