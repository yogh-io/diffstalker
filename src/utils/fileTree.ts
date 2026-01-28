/**
 * Utility for building a tree view from flat file paths.
 * Collapses single-child directories into combined path segments.
 */

export interface FileTreeNode {
  name: string; // Display name (may be collapsed path like "src/main/java")
  fullPath: string; // Full path from root
  isDirectory: boolean;
  children: FileTreeNode[];
  fileIndex?: number; // Index into original files array (for files only)
  depth: number;
}

export interface TreeRowItem {
  type: 'directory' | 'file';
  name: string;
  fullPath: string;
  depth: number;
  fileIndex?: number;
  isLast: boolean; // Is this the last child at its level
  parentIsLast: boolean[]; // Track which parent levels are "last" for drawing tree lines
}

/**
 * Build a tree structure from flat file paths.
 * Paths should be sorted alphabetically before calling this.
 */
export function buildFileTree<T extends { path: string }>(files: T[]): FileTreeNode {
  // Root node
  const root: FileTreeNode = {
    name: '',
    fullPath: '',
    isDirectory: true,
    children: [],
    depth: 0,
  };

  // Build initial trie structure
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const parts = file.path.split('/');
    let current = root;

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const isFile = j === parts.length - 1;
      const pathSoFar = parts.slice(0, j + 1).join('/');

      let child = current.children.find((c) => c.name === part && c.isDirectory === !isFile);

      if (!child) {
        child = {
          name: part,
          fullPath: pathSoFar,
          isDirectory: !isFile,
          children: [],
          depth: current.depth + 1,
          fileIndex: isFile ? i : undefined,
        };
        current.children.push(child);
      }

      current = child;
    }
  }

  // Collapse single-child directories
  collapseTree(root);

  // Sort children: directories first, then files, alphabetically
  sortTree(root);

  return root;
}

/**
 * Collapse single-child directory chains.
 * e.g., a -> b -> c -> file becomes "a/b/c" -> file
 */
function collapseTree(node: FileTreeNode): void {
  // First, recursively collapse children
  for (const child of node.children) {
    collapseTree(child);
  }

  // Then collapse this node's single-child directory chains
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];

    // Collapse if: directory with exactly one child that is also a directory
    while (child.isDirectory && child.children.length === 1 && child.children[0].isDirectory) {
      const grandchild = child.children[0];
      child.name = `${child.name}/${grandchild.name}`;
      child.fullPath = grandchild.fullPath;
      child.children = grandchild.children;
      // Update depths of all descendants
      updateDepths(child, child.depth);
    }
  }
}

/**
 * Update depths recursively after collapsing.
 */
function updateDepths(node: FileTreeNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) {
    updateDepths(child, depth + 1);
  }
}

/**
 * Sort tree: directories first (alphabetically), then files (alphabetically).
 */
function sortTree(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    // Directories before files
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    // Alphabetically within same type
    return a.name.localeCompare(b.name);
  });

  for (const child of node.children) {
    sortTree(child);
  }
}

/**
 * Flatten tree into a list of row items for rendering.
 * Skips the root node (which has empty name).
 */
export function flattenTree(root: FileTreeNode): TreeRowItem[] {
  const rows: TreeRowItem[] = [];

  function traverse(node: FileTreeNode, parentIsLast: boolean[]): void {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isLast = i === node.children.length - 1;

      rows.push({
        type: child.isDirectory ? 'directory' : 'file',
        name: child.name,
        fullPath: child.fullPath,
        depth: child.depth - 1, // Subtract 1 because root is depth 0
        fileIndex: child.fileIndex,
        isLast,
        parentIsLast: [...parentIsLast],
      });

      if (child.isDirectory) {
        traverse(child, [...parentIsLast, isLast]);
      }
    }
  }

  traverse(root, []);
  return rows;
}

/**
 * Build tree prefix for rendering (the │ ├ └ characters).
 */
export function buildTreePrefix(row: TreeRowItem): string {
  let prefix = '';

  // Add vertical lines for parent levels
  for (let i = 0; i < row.depth; i++) {
    if (row.parentIsLast[i]) {
      prefix += '  '; // Parent was last, no line needed
    } else {
      prefix += '│ '; // Parent has siblings below, draw line
    }
  }

  // Add connector for this item
  if (row.depth >= 0) {
    if (row.isLast) {
      prefix += '└ ';
    } else {
      prefix += '├ ';
    }
  }

  return prefix;
}
