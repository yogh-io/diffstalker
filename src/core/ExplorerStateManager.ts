import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { getIgnoredFiles } from '../git/ignoreUtils.js';
import type { FileStatus } from '../git/status.js';

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

export interface GitStatusMap {
  files: Map<string, { status: FileStatus; staged: boolean }>;
  directories: Set<string>; // Directories that contain changes
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
 * It handles directory loading, file selection, and navigation with tree view support.
 */
export class ExplorerStateManager extends EventEmitter<ExplorerStateEventMap> {
  private repoPath: string;
  private options: ExplorerOptions;
  private expandedPaths: Set<string> = new Set();
  private gitStatusMap: GitStatusMap = { files: new Map(), directories: new Set() };

  private _state: ExplorerState = {
    currentPath: '',
    tree: null,
    displayRows: [],
    selectedIndex: 0,
    selectedFile: null,
    isLoading: false,
    error: null,
  };

  constructor(repoPath: string, options: Partial<ExplorerOptions>) {
    super();
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
   */
  setGitStatus(statusMap: GitStatusMap): void {
    this.gitStatusMap = statusMap;
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
      const tree = await this.buildTreeNode('', 0);
      if (tree) {
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
      } else {
        this.updateState({
          tree: null,
          displayRows: [],
          isLoading: false,
          error: 'Failed to load directory',
        });
      }
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
   * Build a tree node for a directory path.
   */
  private async buildTreeNode(
    relativePath: string,
    depth: number
  ): Promise<ExplorerTreeNode | null> {
    try {
      const fullPath = path.join(this.repoPath, relativePath);
      const stats = await fs.promises.stat(fullPath);

      if (!stats.isDirectory()) {
        // It's a file
        return {
          name: path.basename(relativePath) || this.getRepoName(),
          path: relativePath,
          isDirectory: false,
          expanded: false,
          children: [],
          childrenLoaded: true,
        };
      }

      const isExpanded = this.expandedPaths.has(relativePath);

      const node: ExplorerTreeNode = {
        name: path.basename(relativePath) || this.getRepoName(),
        path: relativePath,
        isDirectory: true,
        expanded: isExpanded,
        children: [],
        childrenLoaded: false,
      };

      // Always load children for root, or if expanded
      if (relativePath === '' || isExpanded) {
        await this.loadChildrenForNode(node);
      }

      return node;
    } catch (err) {
      return null;
    }
  }

  /**
   * Load children for a directory node.
   */
  private async loadChildrenForNode(node: ExplorerTreeNode): Promise<void> {
    if (node.childrenLoaded) return;

    try {
      const fullPath = path.join(this.repoPath, node.path);
      const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

      // Build list of paths for gitignore check
      const pathsToCheck = entries.map((e) => (node.path ? path.join(node.path, e.name) : e.name));

      // Get ignored files
      const ignoredFiles = this.options.hideGitignored
        ? await getIgnoredFiles(this.repoPath, pathsToCheck)
        : new Set<string>();

      const children: ExplorerTreeNode[] = [];

      for (const entry of entries) {
        // Filter dot-prefixed hidden files
        if (this.options.hideHidden && entry.name.startsWith('.')) {
          continue;
        }

        const entryPath = node.path ? path.join(node.path, entry.name) : entry.name;

        // Filter gitignored files
        if (this.options.hideGitignored && ignoredFiles.has(entryPath)) {
          continue;
        }

        const isDir = entry.isDirectory();
        const isExpanded = this.expandedPaths.has(entryPath);

        const childNode: ExplorerTreeNode = {
          name: entry.name,
          path: entryPath,
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

      // Sort: directories first, then alphabetically
      children.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      // Collapse single-child directory chains
      this.collapseNode(node, children);

      node.childrenLoaded = true;
    } catch (err) {
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
  private flattenTree(root: ExplorerTreeNode): ExplorerDisplayRow[] {
    const rows: ExplorerDisplayRow[] = [];

    const traverse = (node: ExplorerTreeNode, depth: number, parentIsLast: boolean[]): void => {
      // Skip root node in display (but process its children)
      if (depth === 0) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          const isLast = i === node.children.length - 1;

          // Apply filter if showOnlyChanges is enabled
          if (this.options.showOnlyChanges) {
            if (child.isDirectory && !child.hasChangedChildren) continue;
            if (!child.isDirectory && !child.gitStatus) continue;
          }

          rows.push({
            node: child,
            depth: 0,
            isLast,
            parentIsLast: [],
          });

          if (child.isDirectory && child.expanded) {
            traverse(child, 1, [isLast]);
          }
        }
        return;
      }

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const isLast = i === node.children.length - 1;

        // Apply filter if showOnlyChanges is enabled
        if (this.options.showOnlyChanges) {
          if (child.isDirectory && !child.hasChangedChildren) continue;
          if (!child.isDirectory && !child.gitStatus) continue;
        }

        rows.push({
          node: child,
          depth,
          isLast,
          parentIsLast: [...parentIsLast],
        });

        if (child.isDirectory && child.expanded) {
          traverse(child, depth + 1, [...parentIsLast, isLast]);
        }
      }
    };

    traverse(root, 0, []);
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
        const warning = `Warning: Large file (${(stats.size / 1024).toFixed(1)} KB)\n\n`;
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
   * Get all file paths in the repo (for file finder).
   * Scans the filesystem directly to get all files, not just expanded ones.
   */
  async getAllFilePaths(): Promise<string[]> {
    const paths: string[] = [];

    const scanDir = async (dirPath: string): Promise<void> => {
      try {
        const fullPath = path.join(this.repoPath, dirPath);
        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

        // Build list of paths for gitignore check
        const pathsToCheck = entries.map((e) => (dirPath ? path.join(dirPath, e.name) : e.name));

        // Get ignored files
        const ignoredFiles = this.options.hideGitignored
          ? await getIgnoredFiles(this.repoPath, pathsToCheck)
          : new Set<string>();

        for (const entry of entries) {
          // Filter dot-prefixed hidden files
          if (this.options.hideHidden && entry.name.startsWith('.')) {
            continue;
          }

          const entryPath = dirPath ? path.join(dirPath, entry.name) : entry.name;

          // Filter gitignored files
          if (this.options.hideGitignored && ignoredFiles.has(entryPath)) {
            continue;
          }

          if (entry.isDirectory()) {
            await scanDir(entryPath);
          } else {
            paths.push(entryPath);
          }
        }
      } catch (err) {
        // Ignore errors for individual directories
      }
    };

    await scanDir('');
    return paths;
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
