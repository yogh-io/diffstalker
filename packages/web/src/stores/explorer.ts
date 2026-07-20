/**
 * useExplorerStore: the Explorer view-model — the browser analog of the
 * CLI's ExplorerViewModel (packages/cli/src/state/ExplorerViewModel.ts).
 *
 * The daemon serves the tree STATELESSLY (one GET /tree per directory
 * level, GET /file per read); this store holds everything the view needs
 * synchronously: loaded children per directory, the expansion set, the
 * flattened display rows, the selected file and its FileForDisplay flags.
 *
 * Wire note — the daemon's query params are SHOW flags, inverted from
 * core's hide options: `hidden=false` hides dotfiles, `ignored=false`
 * hides gitignored entries. The store's showHidden/showIgnored toggles
 * therefore map STRAIGHT onto the wire (`hidden: showHidden`), and both
 * default false (dotfiles and ignored files hidden). changedOnly is a
 * pure client-side row filter (the CLI's `g`) — no refetch.
 *
 * Toggling hidden/ignored invalidates every cached listing, so the tree
 * reloads root + all expanded dirs with the new params (expansion is
 * kept). A repoId change resets the whole tree and selection; the view
 * re-triggers ensureRoot. Filter toggles survive a repo switch — they
 * are user preference, not repo data.
 *
 * Errors: never thrown to the view. Connection loss collapses into the
 * same calm reconnect line the repo store uses (the browser cannot
 * respawn a daemon; the repo store owns recovery — its next snapshot
 * revives the app and the user's next tree action re-pulls). Daemon
 * errors (ENOENT etc.) land in `error` / `fileError` as-is.
 */

import { computed, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import { isConnectionError } from '../api/errors';
import { useRepoStore, CONNECTION_LOST_MESSAGE } from './repo';
import type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';

/** One flattened tree row the view renders. */
export interface ExplorerRow {
  entry: DirEntry;
  /** 0 for root-level entries. */
  depth: number;
  /** Dirs only: currently expanded. */
  isExpanded: boolean;
  /** Dirs only: children fetch in flight. */
  isLoading: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useExplorerStore = defineStore('explorer', () => {
  const repo = useRepoStore();
  const client = new DiffstalkerClient();

  // --- Reactive state (shallowRefs, whole-value replacement) ---

  /** Loaded children per directory path ('' = repo root). */
  const children = shallowRef<ReadonlyMap<string, DirEntry[]>>(new Map());
  /** Expanded directory paths (root '' is implicitly always expanded). */
  const expanded = shallowRef<ReadonlySet<string>>(new Set());
  /** Directories with a children fetch in flight. */
  const loadingDirs = shallowRef<ReadonlySet<string>>(new Set());
  const rootLoaded = shallowRef(false);
  const rootLoading = shallowRef(false);
  /** Tree-level error (root/dir listing failures, connection loss). */
  const error = shallowRef<string | null>(null);

  // Filter toggles. Defaults: dotfiles hidden, gitignored hidden.
  const showHidden = shallowRef(false);
  const showIgnored = shallowRef(false);
  const changedOnly = shallowRef(false);

  // File selection.
  const selectedPath = shallowRef<string | null>(null);
  const file = shallowRef<FileForDisplay | null>(null);
  const fileLoading = shallowRef(false);
  const fileError = shallowRef<string | null>(null);

  // --- Non-reactive internals ---

  /** Bumped on reset; async completions from before a reset are dropped. */
  let generation = 0;
  /**
   * Bumped on reset AND at the top of every full reload (filter toggle,
   * refresh). Every tree fetch captures + checks it, so an in-flight
   * expand from before a toggle cannot write pre-toggle children back
   * over the freshly reloaded cache.
   */
  let treeGeneration = 0;

  /** Reset all tree + selection state (repo switch). Toggles survive. */
  function reset(): void {
    generation++;
    treeGeneration++;
    children.value = new Map();
    expanded.value = new Set();
    loadingDirs.value = new Set();
    rootLoaded.value = false;
    rootLoading.value = false;
    error.value = null;
    selectedPath.value = null;
    file.value = null;
    fileLoading.value = false;
    fileError.value = null;
  }

  watch(
    () => repo.repoId,
    () => reset()
  );

  /** Collapse an error into the tree-level line (calm on connection loss). */
  function setTreeError(err: unknown): void {
    error.value = isConnectionError(err) ? CONNECTION_LOST_MESSAGE : errorMessage(err);
  }

  function fetchDir(dir: string): Promise<DirEntry[]> {
    const id = repo.repoId;
    if (id === null) return Promise.resolve([]);
    return client.tree(id, {
      dir,
      // Wire params are SHOW flags — straight mapping, see module docs.
      hidden: showHidden.value,
      ignored: showIgnored.value,
    });
  }

  // --- Tree loading ---

  /**
   * Fetch one directory level into `map`, then recurse into children
   * that are still in the expansion set (used by full reloads so an
   * expanded subtree survives a filter change or refresh).
   */
  async function fetchExpandedInto(map: Map<string, DirEntry[]>, dir: string): Promise<void> {
    const entries = await fetchDir(dir);
    map.set(dir, entries);
    for (const entry of entries) {
      if (entry.type === 'dir' && expanded.value.has(entry.path)) {
        await fetchExpandedInto(map, entry.path);
      }
    }
  }

  /**
   * (Re)load the whole visible tree: root plus every expanded dir, with
   * the current filter params. Replaces the children cache wholesale so
   * no stale listing (pre-toggle) survives — bumping treeGeneration
   * first also drops any in-flight expand started under the old params.
   *
   * Returns false only when THIS reload failed and surfaced the error
   * (a superseded reload defers to the newer one); on failure the old
   * cache is kept, so callers can revert dependent state (the filter
   * toggles) to match what is still displayed.
   */
  async function reloadTree(): Promise<boolean> {
    if (repo.repoId === null) return true;
    treeGeneration++;
    const gen = treeGeneration;
    rootLoading.value = true;
    error.value = null;
    try {
      const map = new Map<string, DirEntry[]>();
      await fetchExpandedInto(map, '');
      if (gen !== treeGeneration) return true;
      children.value = map;
      rootLoaded.value = true;
      return true;
    } catch (err) {
      if (gen !== treeGeneration) return true;
      setTreeError(err);
      return false;
    } finally {
      if (gen === treeGeneration) rootLoading.value = false;
    }
  }

  /** Load the root listing once — the view calls this on activation. */
  async function ensureRoot(): Promise<void> {
    if (rootLoaded.value || rootLoading.value) return;
    await reloadTree();
  }

  /** Re-pull root + expanded dirs (toolbar refresh; keeps expansion). */
  async function refresh(): Promise<void> {
    await reloadTree();
  }

  // --- Expansion ---

  async function loadChildren(path: string): Promise<void> {
    const gen = treeGeneration;
    loadingDirs.value = new Set([...loadingDirs.value, path]);
    try {
      const entries = await fetchDir(path);
      if (gen !== treeGeneration) return;
      const map = new Map(children.value);
      map.set(path, entries);
      children.value = map;
      // The tree is reachable again — an earlier failure line is stale.
      error.value = null;
    } catch (err) {
      if (gen !== treeGeneration) return;
      // Failed expand: collapse back so the chevron stays truthful.
      const next = new Set(expanded.value);
      next.delete(path);
      expanded.value = next;
      setTreeError(err);
    } finally {
      // Always clear the per-dir spinner — even when the result was
      // dropped as stale, THIS was the fetch that set it (a reset
      // replaces loadingDirs wholesale, so the delete is a no-op there).
      const next = new Set(loadingDirs.value);
      if (next.delete(path)) loadingDirs.value = next;
    }
  }

  /**
   * Expand or collapse a directory. First expand fetches its children;
   * a re-expand serves the cached listing (a refresh() re-pulls).
   */
  async function toggleDir(path: string): Promise<void> {
    if (expanded.value.has(path)) {
      const next = new Set(expanded.value);
      next.delete(path);
      expanded.value = next;
      return;
    }
    expanded.value = new Set([...expanded.value, path]);
    if (!children.value.has(path)) {
      await loadChildren(path);
    }
  }

  /** Collapse a directory (keyboard Left on an expanded dir). */
  function collapseDir(path: string): void {
    if (!expanded.value.has(path)) return;
    const next = new Set(expanded.value);
    next.delete(path);
    expanded.value = next;
  }

  // --- Filters ---

  async function setShowHidden(value: boolean): Promise<void> {
    if (showHidden.value === value) return;
    showHidden.value = value;
    // Failed reload keeps the old (pre-toggle) tree — revert the flag
    // so the button state matches the displayed data. Error line stays.
    if (!(await reloadTree())) showHidden.value = !value;
  }

  async function setShowIgnored(value: boolean): Promise<void> {
    if (showIgnored.value === value) return;
    showIgnored.value = value;
    if (!(await reloadTree())) showIgnored.value = !value;
  }

  /** Client-side filter — flips instantly, no refetch. */
  function setChangedOnly(value: boolean): void {
    changedOnly.value = value;
  }

  // --- File selection ---

  /** Load a file into the content pane. Flags stay flags — the view
   *  renders binary/truncated/tooLarge states from them. */
  async function openFile(path: string): Promise<void> {
    const id = repo.repoId;
    if (id === null) return;
    const gen = generation;
    selectedPath.value = path;
    fileError.value = null;
    fileLoading.value = true;
    try {
      const result = await client.file(id, path);
      if (gen !== generation || selectedPath.value !== path) return;
      file.value = result;
    } catch (err) {
      if (gen !== generation || selectedPath.value !== path) return;
      file.value = null;
      fileError.value = isConnectionError(err) ? CONNECTION_LOST_MESSAGE : errorMessage(err);
    } finally {
      if (gen === generation && selectedPath.value === path) fileLoading.value = false;
    }
  }

  function clearSelection(): void {
    selectedPath.value = null;
    file.value = null;
    fileError.value = null;
    fileLoading.value = false;
  }

  // --- Display rows ---

  function passesChangedOnly(entry: DirEntry): boolean {
    if (!changedOnly.value) return true;
    return entry.type === 'dir' ? entry.hasChanges === true : entry.gitStatus !== undefined;
  }

  /**
   * The flattened visible tree: loaded children of the root, expanded
   * dirs inlined depth-first — the single row model both rendering and
   * keyboard navigation consume.
   */
  const rows = computed<ExplorerRow[]>(() => {
    const out: ExplorerRow[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const entry of children.value.get(dir) ?? []) {
        if (!passesChangedOnly(entry)) continue;
        const isExpanded = entry.type === 'dir' && expanded.value.has(entry.path);
        out.push({
          entry,
          depth,
          isExpanded,
          isLoading: loadingDirs.value.has(entry.path),
        });
        if (isExpanded) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  });

  return {
    // reactive state
    rows,
    rootLoaded,
    rootLoading,
    error,
    showHidden,
    showIgnored,
    changedOnly,
    selectedPath,
    file,
    fileLoading,
    fileError,
    // tree
    ensureRoot,
    refresh,
    toggleDir,
    collapseDir,
    // filters
    setShowHidden,
    setShowIgnored,
    setChangedOnly,
    // file
    openFile,
    clearSelection,
  };
});
