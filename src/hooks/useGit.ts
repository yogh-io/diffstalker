import { useState, useEffect, useCallback, useRef } from 'react';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { watch } from 'chokidar';
import {
  getStatus,
  stageFile,
  unstageFile,
  stageAll as gitStageAll,
  unstageAll as gitUnstageAll,
  discardChanges as gitDiscardChanges,
  commit as gitCommit,
  getHeadMessage,
  GitStatus,
  FileEntry,
} from '../git/status.js';
import { getDiff, getDiffForUntracked, getStagedDiff, DiffResult } from '../git/diff.js';

export interface UseGitResult {
  status: GitStatus | null;
  diff: DiffResult | null;
  stagedDiff: string;
  selectedFile: FileEntry | null;
  isLoading: boolean;
  error: string | null;
  selectFile: (file: FileEntry | null) => void;
  stage: (file: FileEntry) => Promise<void>;
  unstage: (file: FileEntry) => Promise<void>;
  discard: (file: FileEntry) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (message: string, amend?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  getHeadCommitMessage: () => Promise<string>;
}

export function useGit(repoPath: string | null): UseGitResult {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [stagedDiff, setStagedDiff] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setStatus(null);
      setDiff(null);
      return;
    }

    // Prevent concurrent refreshes
    if (refreshingRef.current) return;
    refreshingRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      const newStatus = await getStatus(repoPath);
      setStatus(newStatus);

      if (!newStatus.isRepo) {
        setError('Not a git repository');
        setDiff(null);
        setStagedDiff('');
        return;
      }

      // Always fetch staged diff for AI commit generation
      const allStagedDiff = await getStagedDiff(repoPath);
      setStagedDiff(allStagedDiff.raw);

      // Also fetch all unstaged diff for display when nothing selected
      const allUnstagedDiff = await getDiff(repoPath, undefined, false);

      // Update display diff based on selected file
      if (selectedFile) {
        const currentFile = newStatus.files.find(
          f => f.path === selectedFile.path && f.staged === selectedFile.staged
        );
        if (currentFile) {
          if (currentFile.status === 'untracked') {
            const fileDiff = await getDiffForUntracked(repoPath, currentFile.path);
            setDiff(fileDiff);
          } else {
            const fileDiff = await getDiff(repoPath, currentFile.path, currentFile.staged);
            setDiff(fileDiff);
          }
        } else {
          setSelectedFile(null);
          // Show all changes when selection is cleared
          setDiff(allUnstagedDiff.raw ? allUnstagedDiff : allStagedDiff);
        }
      } else {
        // Show all unstaged diff by default, fall back to staged if no unstaged
        if (allUnstagedDiff.raw) {
          setDiff(allUnstagedDiff);
        } else if (allStagedDiff.raw) {
          setDiff(allStagedDiff);
        } else {
          setDiff({ raw: '', lines: [] });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
      refreshingRef.current = false;
    }
  }, [repoPath, selectedFile]);

  // Watch .git directory for external changes
  useEffect(() => {
    if (!repoPath) return;

    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) return;

    // Watch key git files for changes
    const indexFile = path.join(gitDir, 'index');
    const headFile = path.join(gitDir, 'HEAD');
    const refsDir = path.join(gitDir, 'refs');

    const watcher = watch([indexFile, headFile, refsDir], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    // Debounce refresh to avoid hammering during rapid changes
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refresh();
      }, 200);
    };

    watcher.on('change', debouncedRefresh);
    watcher.on('add', debouncedRefresh);
    watcher.on('unlink', debouncedRefresh);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    };
  }, [repoPath, refresh]);

  // Refresh when repoPath changes
  useEffect(() => {
    refresh();
  }, [repoPath]);

  // Update diff when selected file changes
  useEffect(() => {
    if (!repoPath || !status?.isRepo) return;

    const updateDiff = async () => {
      if (selectedFile) {
        if (selectedFile.status === 'untracked') {
          const fileDiff = await getDiffForUntracked(repoPath, selectedFile.path);
          setDiff(fileDiff);
        } else {
          const fileDiff = await getDiff(repoPath, selectedFile.path, selectedFile.staged);
          setDiff(fileDiff);
        }
      } else {
        const allDiff = await getStagedDiff(repoPath);
        setDiff(allDiff);
      }
    };

    updateDiff();
  }, [selectedFile, repoPath, status?.isRepo]);

  const selectFile = useCallback((file: FileEntry | null) => {
    setSelectedFile(file);
  }, []);

  const stage = useCallback(async (file: FileEntry) => {
    if (!repoPath) return;
    try {
      await stageFile(repoPath, file.path);
      await refresh();
    } catch (err) {
      setError(`Failed to stage ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath, refresh]);

  const unstage = useCallback(async (file: FileEntry) => {
    if (!repoPath) return;
    try {
      await unstageFile(repoPath, file.path);
      await refresh();
    } catch (err) {
      setError(`Failed to unstage ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath, refresh]);

  const discard = useCallback(async (file: FileEntry) => {
    if (!repoPath) return;
    // Only discard unstaged, non-untracked files (modified/deleted)
    if (file.staged || file.status === 'untracked') {
      return;
    }
    try {
      await gitDiscardChanges(repoPath, file.path);
      await refresh();
    } catch (err) {
      setError(`Failed to discard ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath, refresh]);

  const stageAll = useCallback(async () => {
    if (!repoPath) return;
    try {
      await gitStageAll(repoPath);
      await refresh();
    } catch (err) {
      setError(`Failed to stage all: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath, refresh]);

  const unstageAll = useCallback(async () => {
    if (!repoPath) return;
    try {
      await gitUnstageAll(repoPath);
      await refresh();
    } catch (err) {
      setError(`Failed to unstage all: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath, refresh]);

  const commit = useCallback(async (message: string, amend: boolean = false) => {
    if (!repoPath) return;
    try {
      await gitCommit(repoPath, message, amend);
      await refresh();
    } catch (err) {
      setError(`Failed to commit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath, refresh]);

  const getHeadCommitMessage = useCallback(async (): Promise<string> => {
    if (!repoPath) return '';
    return getHeadMessage(repoPath);
  }, [repoPath]);

  return {
    status,
    diff,
    stagedDiff,
    selectedFile,
    isLoading,
    error,
    selectFile,
    stage,
    unstage,
    discard,
    stageAll,
    unstageAll,
    commit,
    refresh,
    getHeadCommitMessage,
  };
}
