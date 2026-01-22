import { useState, useEffect, useCallback, useMemo, Dispatch, SetStateAction } from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

export interface ExplorerItem {
  name: string;
  path: string; // relative to repo root
  isDirectory: boolean;
}

export interface UseExplorerStateProps {
  repoPath: string;
  isActive: boolean;
  topPaneHeight: number;
  explorerScrollOffset: number;
  setExplorerScrollOffset: Dispatch<SetStateAction<number>>;
  fileScrollOffset: number;
  setFileScrollOffset: Dispatch<SetStateAction<number>>;
  hideHiddenFiles: boolean;
  hideGitignored: boolean;
}

export interface UseExplorerStateResult {
  currentPath: string; // relative path (e.g., "src/components")
  items: ExplorerItem[];
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  selectedFile: { path: string; content: string; truncated?: boolean } | null;
  fileScrollOffset: number;
  setFileScrollOffset: Dispatch<SetStateAction<number>>;

  // Navigation
  navigateUp: () => void;
  navigateDown: () => void;
  enterDirectory: () => void; // Enter on folder or ".."
  goUp: () => void; // Backspace - go to parent

  // Loading state
  isLoading: boolean;
  error: string | null;

  // Content info
  explorerTotalRows: number;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const WARN_FILE_SIZE = 100 * 1024; // 100KB

// Check if content appears to be binary
function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (common in binary files)
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// Get ignored files using git check-ignore
async function getIgnoredFiles(repoPath: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();

  const git = simpleGit(repoPath);
  const ignoredFiles = new Set<string>();
  const batchSize = 100;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    try {
      const result = await git.raw(['check-ignore', ...batch]);
      const ignored = result
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
      for (const f of ignored) {
        ignoredFiles.add(f);
      }
    } catch {
      // check-ignore exits with code 1 if no files are ignored
    }
  }

  return ignoredFiles;
}

export function useExplorerState({
  repoPath,
  isActive,
  topPaneHeight,
  explorerScrollOffset,
  setExplorerScrollOffset,
  fileScrollOffset,
  setFileScrollOffset,
  hideHiddenFiles,
  hideGitignored,
}: UseExplorerStateProps): UseExplorerStateResult {
  const [currentPath, setCurrentPath] = useState('');
  const [items, setItems] = useState<ExplorerItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedFile, setSelectedFile] = useState<{
    path: string;
    content: string;
    truncated?: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load directory contents when path changes or tab becomes active
  useEffect(() => {
    if (!isActive || !repoPath) return;

    const loadDirectory = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const fullPath = path.join(repoPath, currentPath);

        // Read directory
        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

        // Build list of paths for gitignore check
        const pathsToCheck = entries.map((e) =>
          currentPath ? path.join(currentPath, e.name) : e.name
        );

        // Get ignored files (only if we need to filter them)
        const ignoredFiles = hideGitignored
          ? await getIgnoredFiles(repoPath, pathsToCheck)
          : new Set<string>();

        // Filter and map entries
        const explorerItems: ExplorerItem[] = entries
          .filter((entry) => {
            // Filter dot-prefixed hidden files (e.g., .env, .gitignore)
            if (hideHiddenFiles && entry.name.startsWith('.')) {
              return false;
            }

            // Filter gitignored files
            if (hideGitignored) {
              const relativePath = currentPath ? path.join(currentPath, entry.name) : entry.name;
              if (ignoredFiles.has(relativePath)) {
                return false;
              }
            }

            return true;
          })
          .map((entry) => ({
            name: entry.name,
            path: currentPath ? path.join(currentPath, entry.name) : entry.name,
            isDirectory: entry.isDirectory(),
          }));

        // Sort: directories first (alphabetical), then files (alphabetical)
        explorerItems.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        // Add ".." at the beginning if not at root
        if (currentPath) {
          explorerItems.unshift({
            name: '..',
            path: path.dirname(currentPath) || '',
            isDirectory: true,
          });
        }

        setItems(explorerItems);
        setSelectedIndex(0);
        setExplorerScrollOffset(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to read directory');
        setItems([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadDirectory();
  }, [repoPath, currentPath, isActive, setExplorerScrollOffset, hideHiddenFiles, hideGitignored]);

  // Load file content when selection changes to a file
  useEffect(() => {
    if (!isActive || !repoPath || items.length === 0) {
      setSelectedFile(null);
      return;
    }

    const selected = items[selectedIndex];
    if (!selected || selected.isDirectory) {
      setSelectedFile(null);
      return;
    }

    const loadFile = async () => {
      try {
        const fullPath = path.join(repoPath, selected.path);
        const stats = await fs.promises.stat(fullPath);

        // Check file size
        if (stats.size > MAX_FILE_SIZE) {
          setSelectedFile({
            path: selected.path,
            content: `File too large to display (${(stats.size / 1024 / 1024).toFixed(2)} MB).\nMaximum size: 1 MB`,
            truncated: true,
          });
          return;
        }

        const buffer = await fs.promises.readFile(fullPath);

        // Check if binary
        if (isBinaryContent(buffer)) {
          setSelectedFile({
            path: selected.path,
            content: 'Binary file - cannot display',
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

        // Truncate if needed (shouldn't happen given MAX_FILE_SIZE, but just in case)
        const maxLines = 5000;
        const lines = content.split('\n');
        if (lines.length > maxLines) {
          content =
            lines.slice(0, maxLines).join('\n') +
            `\n\n... (truncated, ${lines.length - maxLines} more lines)`;
          truncated = true;
        }

        setSelectedFile({
          path: selected.path,
          content,
          truncated,
        });
        setFileScrollOffset(0);
      } catch (err) {
        setSelectedFile({
          path: selected.path,
          content: err instanceof Error ? `Error: ${err.message}` : 'Failed to read file',
        });
      }
    };

    loadFile();
  }, [repoPath, items, selectedIndex, isActive, setFileScrollOffset]);

  // Total rows for scroll calculations (item count)
  const explorerTotalRows = useMemo(() => items.length, [items]);

  // Navigation handlers
  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => {
      const newIndex = Math.max(0, prev - 1);
      // When scrolled, the top indicator takes a row, so first visible item is scrollOffset
      // but we want to keep item visible above the indicator when scrolling up
      if (newIndex < explorerScrollOffset) {
        setExplorerScrollOffset(newIndex);
      }
      return newIndex;
    });
  }, [explorerScrollOffset, setExplorerScrollOffset]);

  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) => {
      const newIndex = Math.min(items.length - 1, prev + 1);
      // Calculate visible area: topPaneHeight - 1 for "EXPLORER" header
      // When content needs scrolling, ScrollableList reserves 2 more rows for indicators
      const maxHeight = topPaneHeight - 1;
      const needsScrolling = items.length > maxHeight;
      const availableHeight = needsScrolling ? maxHeight - 2 : maxHeight;
      const visibleEnd = explorerScrollOffset + availableHeight;
      if (newIndex >= visibleEnd) {
        setExplorerScrollOffset(explorerScrollOffset + 1);
      }
      return newIndex;
    });
  }, [items.length, explorerScrollOffset, topPaneHeight, setExplorerScrollOffset]);

  const enterDirectory = useCallback(() => {
    const selected = items[selectedIndex];
    if (!selected) return;

    if (selected.isDirectory) {
      if (selected.name === '..') {
        // Go to parent directory
        setCurrentPath(path.dirname(currentPath) || '');
      } else {
        // Enter the directory
        setCurrentPath(selected.path);
      }
    }
    // If it's a file, do nothing (file content is already shown in bottom pane)
  }, [items, selectedIndex, currentPath]);

  const goUp = useCallback(() => {
    if (currentPath) {
      setCurrentPath(path.dirname(currentPath) || '');
    }
  }, [currentPath]);

  return {
    currentPath,
    items,
    selectedIndex,
    setSelectedIndex,
    selectedFile,
    fileScrollOffset,
    setFileScrollOffset,
    navigateUp,
    navigateDown,
    enterDirectory,
    goUp,
    isLoading,
    error,
    explorerTotalRows,
  };
}
