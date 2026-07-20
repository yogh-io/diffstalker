import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { DiffstalkerClient } from '@diffstalker/client';
import type { FileStatus } from '@diffstalker/core/git/status';
import type { GitStatusMap } from '@diffstalker/core/git/explorerData';
import * as logger from '@diffstalker/core/utils/logger';

/** Maximum file size served for display (mirrors the daemon's limit). */
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

/** Maximum lines kept in content before truncation kicks in. */
const MAX_DISPLAY_LINES = 5000;

const WARN_FILE_SIZE = 100 * 1024; // 100KB

export interface SelectedFile {
  path: string;
  content: string;
  truncated?: boolean;
}

/**
 * Tree node for explorer view.
 */
export interface ExplorerTreeNode {
  name: string; // Display name (may be collapsed path like "src/main/java")
  path: string; // Full path from repo root
  isDirectory: boolean;
  expanded: boolean;
  children: ExplorerTreeNode[];
  childrenLoaded: boolean; // Whether children have been fetched
  gitStatus?: FileStatus; // For files: M/A/D/?/R
  hasChangedChildren?: boolean; // For directories: contains changed files
}

/**
 * Flattened row for display.
 */
export interface ExplorerDisplayRow {
  node: ExplorerTreeNode;
  depth: number;
  isLast: boolean;
  parentIsLast: boolean[]; // Track which parent levels are "last" for tree lines
}

export interface ExplorerState {
  currentPath: string; // Root of the tree (usually '')
  tree: ExplorerTreeNode | null;
  displayRows: ExplorerDisplayRow[];
  selectedIndex: number;
  selectedFile: SelectedFile | null;
  isLoading: boolean;
  error: string | null;
}

export interface ExplorerOptions {
  hideHidden: boolean;
  hideGitignored: boolean;
  showOnlyChanges: boolean;
}

type ExplorerStateEventMap = {
  'state-change': [ExplorerState];
};

/**
 * ExplorerViewModel is the TUI's file-explorer state, independent of React.
 * It owns tree expansion, display rows, selection, navigation, and the
 * flag->prose conversion for file previews — the pure view-model half of
 * the old in-process explorer manager (its fs/git I/O now lives on the
 * daemon).
 *
 * All filesystem/git I/O now goes through the daemon: directory listings
 * (client.tree), file reads (client.file), and the file-finder source
 * (client.files). Nothing here touches disk; the daemon owns that.
 */
export class ExplorerViewModel extends EventEmitter<ExplorerStateEventMap> {
  private client: DiffstalkerClient;
  private repoId: string | null;
  private repoPath: string;
  private options: ExplorerOptions;
  private expandedPaths: Set<string> = new Set();
  private gitStatusMap: GitStatusMap = { files: new Map(), directories: new Set() };
  private _cachedFilePaths: string[] | null = null;

  private _state: ExplorerState = {
    currentPath: '',
    tree: null,
    displayRows: [],
    selectedIndex: 0,
    selectedFile: null,
    isLoading: false,
    error: null,
  };

  constructor(
    client: DiffstalkerClient,
    repoId: string | null,
    repoPath: string,
    options: Partial<ExplorerOptions>
  ) {
    super();
    this.client = client;
    this.repoId = repoId;
    this.repoPath = repoPath;
    this.options = {
      hideHidden: options.hideHidden ?? true,
      hideGitignored: options.hideGitignored ?? true,
      showOnlyChanges: options.showOnlyChanges ?? false,
    };
    // Expand root by default
    this.expandedPaths.add('');
  }

  get state(): ExplorerState {
    return this._state;
  }

  private updateState(partial: Partial<ExplorerState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state-change', this._state);
  }

  /**
   * Set filtering options and reload tree.
   */
  async setOptions(options: Partial<ExplorerOptions>): Promise<void> {
    this.options = { ...this.options, ...options };
    await this.loadTree();
  }

  /**
   * Update git status map and refresh display.
   * Also invalidates the file path cache so the next file finder open gets fresh data.
   */
  setGitStatus(statusMap: GitStatusMap): void {
    this.gitStatusMap = statusMap;
    // Invalidate file path cache — reload in background
    this.loadFilePaths();
    // Refresh display to show updated status
    if (this._state.tree) {
      this.applyGitStatusToTree(this._state.tree);
      this.refreshDisplayRows();
    }
  }

  /**
   * Toggle showOnlyChanges filter.
   */
  async toggleShowOnlyChanges(): Promise<void> {
    this.options.showOnlyChanges = !this.options.showOnlyChanges;
    this.refreshDisplayRows();
  }

  /**
   * Check if showOnlyChanges is enabled.
   */
  get showOnlyChanges(): boolean {
    return this.options.showOnlyChanges;
  }

  /**
   * Load the full tree structure.
   */
  async loadTree(): Promise<void> {
    this.updateState({ isLoading: true, error: null });

    try {
      const tree = await this.buildRootNode();
      tree.expanded = true; // Root is always expanded
      this.applyGitStatusToTree(tree);
      const displayRows = this.flattenTree(tree);

      this.updateState({
        tree,
        displayRows,
        selectedIndex: 0,
        selectedFile: null,
        isLoading: false,
      });
    } catch (err) {
      this.updateState({
        error: err instanceof Error ? err.message : 'Failed to read directory',
        tree: null,
        displayRows: [],
        isLoading: false,
      });
    }
  }

  /**
   * Build the root node (always the repo root, always a directory) and load
   * its children. The daemon 400/404s a bad path — the error surfaces via
   * loadTree's catch into state.error.
   */
  private async buildRootNode(): Promise<ExplorerTreeNode> {
    const node: ExplorerTreeNode = {
      name: this.getRepoName(),
      path: '',
      isDirectory: true,
      expanded: true,
      children: [],
      childrenLoaded: false,
    };
    await this.loadChildrenForNode(node);
    return node;
  }

  /**
   * Load children for a directory node from the daemon's /tree endpoint.
   */
  private async loadChildrenForNode(node: ExplorerTreeNode): Promise<void> {
    if (node.childrenLoaded) return;

    if (this.repoId === null) {
      node.childrenLoaded = true;
      node.children = [];
      return;
    }

    try {
      // Daemon-served single-level listing: hidden/gitignored filtered,
      // dirs first then alphabetical. hidden/ignored are "show" flags on
      // the wire, so they invert the view-model's "hide" options.
      const entries = await this.client.tree(this.repoId, {
        dir: node.path,
        hidden: !this.options.hideHidden,
        ignored: !this.options.hideGitignored,
      });

      const children: ExplorerTreeNode[] = [];

      for (const entry of entries) {
        const isDir = entry.type === 'dir';
        const isExpanded = this.expandedPaths.has(entry.path);

        const childNode: ExplorerTreeNode = {
          name: entry.name,
          path: entry.path,
          isDirectory: isDir,
          expanded: isExpanded,
          children: [],
          childrenLoaded: !isDir,
        };

        // Recursively load if expanded
        if (isDir && isExpanded) {
          await this.loadChildrenForNode(childNode);
        }

        children.push(childNode);
      }

      // Collapse single-child directory chains
      this.collapseNode(node, children);

      node.childrenLoaded = true;
    } catch (err) {
      logger.warn(
        `Failed to read directory ${node.name}: ${err instanceof Error ? err.message : err}`
      );
      node.childrenLoaded = true;
      node.children = [];
    }
  }

  /**
   * Collapse single-child directory chains.
   * e.g., a -> b -> c -> file becomes "a/b/c" -> file
   */
  private collapseNode(parent: ExplorerTreeNode, children: ExplorerTreeNode[]): void {
    for (const child of children) {
      if (child.isDirectory && child.childrenLoaded) {
        // Collapse if: single child that is also a directory
        while (
          child.children.length === 1 &&
          child.children[0].isDirectory &&
          child.children[0].childrenLoaded
        ) {
          const grandchild = child.children[0];
          child.name = `${child.name}/${grandchild.name}`;
          child.path = grandchild.path;
          child.children = grandchild.children;
          // Inherit expanded state from the collapsed path
          child.expanded = this.expandedPaths.has(child.path);
        }
      }
    }
    parent.children = children;
  }

  /**
   * Apply git status to tree nodes.
   */
  private applyGitStatusToTree(node: ExplorerTreeNode): void {
    if (!node.isDirectory) {
      const status = this.gitStatusMap.files.get(node.path);
      if (status) {
        node.gitStatus = status.status;
      } else {
        node.gitStatus = undefined;
      }
    } else {
      // Check if directory contains any changed files
      node.hasChangedChildren = this.gitStatusMap.directories.has(node.path);
      for (const child of node.children) {
        this.applyGitStatusToTree(child);
      }
    }
  }

  /**
   * Flatten tree into display rows.
   */
  private shouldIncludeNode(node: ExplorerTreeNode): boolean {
    if (!this.options.showOnlyChanges) return true;
    if (node.isDirectory) return !!node.hasChangedChildren;
    return !!node.gitStatus;
  }

  private flattenTree(root: ExplorerTreeNode): ExplorerDisplayRow[] {
    const rows: ExplorerDisplayRow[] = [];

    const traverseChildren = (
      node: ExplorerTreeNode,
      depth: number,
      parentIsLast: boolean[]
    ): void => {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const isLast = i === node.children.length - 1;

        if (!this.shouldIncludeNode(child)) continue;

        rows.push({
          node: child,
          depth,
          isLast,
          parentIsLast: [...parentIsLast],
        });

        if (child.isDirectory && child.expanded) {
          traverseChildren(child, depth + 1, [...parentIsLast, isLast]);
        }
      }
    };

    // Start from root's children at depth 0 (root itself is not displayed)
    traverseChildren(root, 0, []);
    return rows;
  }

  /**
   * Refresh display rows without reloading tree.
   * Maintains selection by path, not by index.
   */
  private refreshDisplayRows(): void {
    if (!this._state.tree) return;

    // Remember the currently selected path
    const currentSelectedPath =
      this._state.displayRows[this._state.selectedIndex]?.node.path ?? null;

    const displayRows = this.flattenTree(this._state.tree);

    // Find the same path in the new rows
    let selectedIndex = 0;
    if (currentSelectedPath !== null) {
      const foundIndex = displayRows.findIndex((row) => row.node.path === currentSelectedPath);
      if (foundIndex >= 0) {
        selectedIndex = foundIndex;
      }
    }

    // Clamp to valid range
    selectedIndex = Math.min(selectedIndex, Math.max(0, displayRows.length - 1));

    this.updateState({ displayRows, selectedIndex });
  }

  /**
   * Get repo name from path.
   */
  private getRepoName(): string {
    return path.basename(this.repoPath) || 'repo';
  }

  /**
   * Load a directory's contents (legacy method, now wraps loadTree).
   */
  async loadDirectory(relativePath: string): Promise<void> {
    this._state.currentPath = relativePath;
    await this.loadTree();
  }

  /**
   * Load a file's contents. The daemon returns display FLAGS
   * (binary/tooLarge/truncated); this view-model layer turns them into the
   * prose the TUI renders.
   */
  async loadFile(itemPath: string): Promise<void> {
    if (this.repoId === null) return;

    try {
      const file = await this.client.file(this.repoId, itemPath);

      if (file.tooLarge) {
        this.updateState({
          selectedFile: {
            path: itemPath,
            content: `File too large to display (${(file.size / 1024 / 1024).toFixed(2)} MB).\nMaximum size: ${MAX_FILE_SIZE / 1024 / 1024} MB`,
            truncated: true,
          },
        });
        return;
      }

      if (file.binary) {
        this.updateState({
          selectedFile: {
            path: itemPath,
            content: 'Binary file - cannot display',
          },
        });
        return;
      }

      let content = file.content;

      if (file.truncated) {
        content += `\n\n... (truncated, ${file.totalLines - MAX_DISPLAY_LINES} more lines)`;
      }

      // Warn about large files. This only prepends prose: `truncated`
      // strictly means "cut at MAX_DISPLAY_LINES" — a >100KB file within
      // the line limit is not flagged truncated.
      if (file.size > WARN_FILE_SIZE) {
        content = `Warning: Large file (${(file.size / 1024).toFixed(1)} KB)\n\n` + content;
      }

      this.updateState({
        selectedFile: {
          path: itemPath,
          content,
          truncated: file.truncated,
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
    const rows = this._state.displayRows;
    if (index < 0 || index >= rows.length) return;

    const row = rows[index];
    this.updateState({ selectedIndex: index });

    if (row && !row.node.isDirectory) {
      await this.loadFile(row.node.path);
    } else {
      this.updateState({ selectedFile: null });
    }
  }

  /**
   * Navigate to previous item.
   */
  navigateUp(currentScrollOffset: number): number | null {
    const newIndex = Math.max(0, this._state.selectedIndex - 1);
    if (newIndex === this._state.selectedIndex) return null;

    this.selectIndex(newIndex);

    if (newIndex < currentScrollOffset) {
      return newIndex;
    }
    return null;
  }

  /**
   * Navigate to next item.
   */
  navigateDown(currentScrollOffset: number, visibleHeight: number): number | null {
    const newIndex = Math.min(this._state.displayRows.length - 1, this._state.selectedIndex + 1);
    if (newIndex === this._state.selectedIndex) return null;

    this.selectIndex(newIndex);

    const needsScrolling = this._state.displayRows.length > visibleHeight;
    const availableHeight = needsScrolling ? visibleHeight - 2 : visibleHeight;
    const visibleEnd = currentScrollOffset + availableHeight;

    if (newIndex >= visibleEnd) {
      return currentScrollOffset + 1;
    }
    return null;
  }

  /**
   * Toggle expand/collapse for selected directory, or go to parent if ".." would be selected.
   */
  async toggleExpand(): Promise<void> {
    const rows = this._state.displayRows;
    const index = this._state.selectedIndex;
    if (index < 0 || index >= rows.length) return;

    const row = rows[index];
    if (!row.node.isDirectory) return;

    const node = row.node;
    if (node.expanded) {
      // Collapse
      this.expandedPaths.delete(node.path);
      node.expanded = false;
    } else {
      // Expand
      this.expandedPaths.add(node.path);
      node.expanded = true;

      // Load children if not loaded
      if (!node.childrenLoaded) {
        await this.loadChildrenForNode(node);
        this.applyGitStatusToTree(node);
      }
    }

    this.refreshDisplayRows();
  }

  /**
   * Enter the selected directory (expand) or open parent directory.
   * This is called when Enter is pressed.
   */
  async enterDirectory(): Promise<void> {
    const rows = this._state.displayRows;
    const index = this._state.selectedIndex;
    if (index < 0 || index >= rows.length) return;

    const row = rows[index];
    if (row.node.isDirectory) {
      await this.toggleExpand();
    }
    // For files, do nothing (file content is already shown)
  }

  /**
   * Go to parent directory - navigate up and collapse the directory we left.
   */
  async goUp(): Promise<void> {
    const rows = this._state.displayRows;
    const index = this._state.selectedIndex;
    if (index < 0 || index >= rows.length) return;

    const row = rows[index];
    const currentPath = row.node.path;

    // Find the parent directory path
    const parentPath = path.dirname(currentPath);
    if (parentPath === '.' || parentPath === '') {
      // Already at root level - nothing to do
      return;
    }

    // If we're inside an expanded directory, collapse it
    // The "inside" directory is the first expanded ancestor of our current selection
    const pathParts = currentPath.split('/');
    for (let i = pathParts.length - 1; i > 0; i--) {
      const ancestorPath = pathParts.slice(0, i).join('/');
      if (this.expandedPaths.has(ancestorPath)) {
        // Collapse this ancestor and select it
        this.expandedPaths.delete(ancestorPath);

        // Find this ancestor in the tree and set expanded = false
        const ancestor = this.findNodeByPath(ancestorPath);
        if (ancestor) {
          ancestor.expanded = false;
        }

        this.refreshDisplayRows();

        // Select the collapsed ancestor (use selectIndex to clear file preview)
        const newRows = this._state.displayRows;
        const ancestorIndex = newRows.findIndex((r) => r.node.path === ancestorPath);
        if (ancestorIndex >= 0) {
          // Update selected index and clear file preview since we're selecting a directory
          this.updateState({ selectedIndex: ancestorIndex, selectedFile: null });
        }
        return;
      }
    }
  }

  /**
   * Find a node by its path in the tree.
   */
  private findNodeByPath(targetPath: string): ExplorerTreeNode | null {
    if (!this._state.tree) return null;

    const search = (node: ExplorerTreeNode): ExplorerTreeNode | null => {
      if (node.path === targetPath) return node;
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };

    return search(this._state.tree);
  }

  /**
   * Load all file paths from the daemon's /files endpoint (git ls-files).
   * Stores result in cache for instant access by FileFinder.
   */
  async loadFilePaths(): Promise<void> {
    if (this.repoId === null) {
      this._cachedFilePaths = [];
      return;
    }
    try {
      this._cachedFilePaths = await this.client.files(this.repoId);
    } catch (err) {
      logger.warn(`Failed to load file paths: ${err instanceof Error ? err.message : err}`);
      this._cachedFilePaths = [];
    }
  }

  /**
   * Get cached file paths (for file finder).
   * Returns empty array if not yet loaded.
   */
  getCachedFilePaths(): string[] {
    return this._cachedFilePaths ?? [];
  }

  /**
   * Navigate to a specific file path in the tree.
   * Expands parent directories as needed.
   */
  async navigateToPath(filePath: string): Promise<boolean> {
    if (!this._state.tree) return false;

    // Expand all parent directories
    const parts = filePath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      this.expandedPaths.add(currentPath);
    }

    // Reload tree with new expanded state
    await this.loadTree();

    // Find the file in display rows
    const index = this._state.displayRows.findIndex((r) => r.node.path === filePath);
    if (index >= 0) {
      await this.selectIndex(index);
      return true;
    }

    return false;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.removeAllListeners();
  }
}
