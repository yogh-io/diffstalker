/**
 * useExplorerStore: the Explorer view-model — the browser analog of the
 * CLI's ExplorerViewModel (packages/cli/src/state/ExplorerViewModel.ts).
 *
 * The daemon serves the tree STATELESSLY (one GET /tree per directory
 * level, GET /file per read); this store holds everything the view needs
 * synchronously: loaded children per directory, the expansion set, the
 * flattened display rows, the selected file and its FileForDisplay flags.
 *
 * Single-child directory chains collapse onto one combined row (like
 * the CLI's explorer and core/view/fileTree's collapseTree): expanding
 * a directory whose listing is exactly one subdirectory auto-fetches
 * down the run (followChain) and the rows computed merges it into a
 * single row (`cli/src/ui`) keyed on the deepest directory.
 *
 * Wire note — the daemon's query params are SHOW flags, inverted from
 * core's hide options: `hidden=false` hides dotfiles, `ignored=false`
 * hides gitignored entries. The store's showHidden/showIgnored toggles
 * therefore map STRAIGHT onto the wire (`hidden: showHidden`), and both
 * default false (dotfiles and ignored files hidden). changedOnly is a
 * pure client-side row filter (the CLI's `g`) — no refetch.
 *
 * revealFile (fuzzy finder, follow mode) walks a repo-relative path:
 * root first, then each ancestor directory is expanded (lazy-loading the
 * levels not yet cached), then the target is opened (a file) or just
 * expanded (a directory). Paths the current filters would hide flip
 * showHidden/showIgnored on first; a failed ancestor listing stops the
 * walk with the error visible.
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
import { useRepoStore, displayError } from './repo';
import type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';

/** One flattened tree row the view renders. */
export interface ExplorerRow {
  /**
   * The entry the row acts on. For a collapsed single-child directory
   * chain this is the DEEPEST directory — expanding/collapsing the row
   * expands/collapses the whole chain.
   */
  entry: DirEntry;
  /**
   * What the row shows. Equals entry.name except for a collapsed chain,
   * where it is the joined path of the merged run (`cli/src/ui`) — the
   * same display the CLI's ExplorerViewModel produces.
   */
  displayName: string;
  /** 0 for root-level entries (a collapsed chain counts as ONE level). */
  depth: number;
  /** Dirs only: currently expanded. */
  isExpanded: boolean;
  /** Dirs only: children fetch in flight. */
  isLoading: boolean;
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
  /**
   * The in-flight root load, so concurrent ensureRoot callers share one
   * fetch AND one completion (see ensureRoot). Dropped on reset: the old
   * repo's load must not be what a new repo's first reveal waits on.
   */
  let rootLoad: Promise<boolean> | null = null;

  /** Reset all tree + selection state (repo switch). Toggles survive. */
  function reset(): void {
    generation++;
    treeGeneration++;
    rootLoad = null;
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
    error.value = displayError(err);
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

  /**
   * Load the root listing once — the view calls this on activation, and so
   * does every reveal.
   *
   * A second caller arriving mid-flight WAITS for that load. Returning
   * early instead (the old `rootLoading` bail) handed it a tree that is not
   * loaded yet, and revealFile reads exactly that to decide whether to walk
   * — so a reveal racing the view's own mount (a deep link, a popped
   * history entry) abandoned the walk without a trace.
   */
  async function ensureRoot(): Promise<void> {
    if (rootLoaded.value) return;
    rootLoad ??= reloadTree().finally(() => {
      rootLoad = null;
    });
    await rootLoad;
  }

  /** Re-pull root + expanded dirs (toolbar refresh; keeps expansion). */
  async function refresh(): Promise<void> {
    await reloadTree();
  }

  // --- Expansion ---

  /**
   * Fetch one directory's listing into the cache. Returns true only
   * when the listing was applied — false on failure OR when the result
   * was dropped as stale — so callers walking ancestors (revealFile)
   * can bail instead of expanding past a broken level.
   */
  async function loadChildren(path: string): Promise<boolean> {
    const gen = treeGeneration;
    loadingDirs.value = new Set([...loadingDirs.value, path]);
    try {
      const entries = await fetchDir(path);
      if (gen !== treeGeneration) return false;
      const map = new Map(children.value);
      map.set(path, entries);
      children.value = map;
      // The tree is reachable again — an earlier failure line is stale.
      error.value = null;
      return true;
    } catch (err) {
      if (gen !== treeGeneration) return false;
      // Failed expand: collapse back so the chevron stays truthful.
      const next = new Set(expanded.value);
      next.delete(path);
      expanded.value = next;
      setTreeError(err);
      return false;
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
   * a re-expand serves the cached listing (a refresh() re-pulls). After
   * an expand, a run of single-child directories below it is followed
   * so the chain renders as one combined row (CLI parity).
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
      if (!(await loadChildren(path))) return;
    }
    await followChain(path);
  }

  /**
   * Auto-expand a run of single-child directories starting below
   * `start`: while a listing is exactly ONE subdirectory (and nothing
   * else), that subdirectory is expanded and its listing fetched too.
   * The rows computed then merges the run into one combined row. Every
   * chain link lands in the expansion set, so a full reload
   * (fetchExpandedInto) re-pulls the whole chain and the merge
   * survives filter toggles and refresh. Stops on a failed or stale
   * fetch (loadChildren's guards).
   */
  async function followChain(start: string): Promise<void> {
    let current = start;
    for (;;) {
      const listing = children.value.get(current);
      if (listing === undefined || listing.length !== 1 || listing[0].type !== 'dir') return;
      const next = listing[0].path;
      if (!expanded.value.has(next)) {
        expanded.value = new Set([...expanded.value, next]);
      }
      if (!children.value.has(next)) {
        if (!(await loadChildren(next))) return;
      }
      current = next;
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
      fileError.value = displayError(err);
    } finally {
      if (gen === generation && selectedPath.value === path) fileLoading.value = false;
    }
  }

  /**
   * Find `target` in the (already loaded) listing of `dir`. A miss with
   * showIgnored off retries once with ignored entries shown — the
   * finder lists gitignored paths the filtered tree does not.
   */
  async function findEntry(dir: string, target: string, gen: number): Promise<DirEntry | null> {
    const entry = children.value.get(dir)?.find((e) => e.path === target);
    if (entry !== undefined) return entry;
    if (showIgnored.value) return null;
    await setShowIgnored(true);
    // Reload failed → flag reverted → the entry still cannot be shown.
    if (gen !== generation || !showIgnored.value) return null;
    return children.value.get(dir)?.find((e) => e.path === target) ?? null;
  }

  /**
   * Reveal a repo-relative path: make sure the root is loaded, walk the
   * segments expanding each ancestor directory (lazy-loading listings
   * not yet cached), then act on the target — a FILE is selected and
   * loaded, a DIRECTORY is just expanded (follow mode can hand us a
   * subdir). The view scrolls the selection into view.
   *
   * Visibility: a dot-segment path is invisible under the default
   * filters, so showHidden flips on first; a segment missing from its
   * parent listing retries once with showIgnored on. The reveal never
   * selects a file its own tree rows cannot show.
   *
   * A failed ancestor listing stops the walk: the error stays visible
   * and the file is NOT opened past a broken level. A repo switch
   * mid-reveal drops the rest (generation guard).
   */
  async function revealFile(path: string): Promise<void> {
    if (repo.repoId === null) return;
    const gen = generation;

    if (!showHidden.value && path.split('/').some((seg) => seg.startsWith('.'))) {
      await setShowHidden(true);
      // Reload failed (flag reverted): the tree cannot show the path.
      if (gen !== generation || !showHidden.value) return;
    }

    await ensureRoot();
    if (gen !== generation || !rootLoaded.value) return;

    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const current = prefix === '' ? parts[i] : `${prefix}/${parts[i]}`;
      const step = await revealStep(prefix, current, i === parts.length - 1, gen);
      if (step !== 'descend') return;
      prefix = current;
    }
    // Every segment was a directory: the target is a dir, now expanded.
    // Follow a single-child chain below it so it merges like a click
    // expansion would.
    if (gen === generation) await followChain(prefix);
  }

  /**
   * One segment of the reveal walk: resolve the entry in its parent's
   * listing, open a file target, expand a directory (lazy-loading its
   * listing). 'bail' stops the walk (failure or staleness) with the
   * error left visible; 'done' means the target was handled.
   */
  async function revealStep(
    prefix: string,
    current: string,
    isLast: boolean,
    gen: number
  ): Promise<'descend' | 'done' | 'bail'> {
    const entry = await findEntry(prefix, current, gen);
    if (entry === null || gen !== generation) return 'bail';
    if (entry.type !== 'dir') {
      // A file: only valid as the last segment (a file mid-path is bogus).
      if (isLast) await openFile(current);
      return 'done';
    }
    if (!expanded.value.has(current)) {
      expanded.value = new Set([...expanded.value, current]);
    }
    if (!children.value.has(current)) {
      const ok = await loadChildren(current);
      if (gen !== generation || !ok) return 'bail';
    }
    return 'descend';
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
   *
   * Single-child directory chains collapse onto ONE row (CLI parity:
   * ExplorerViewModel.collapseNode): a run of cached listings that are
   * each exactly one subdirectory merges into a combined row whose
   * displayName is the joined path and whose entry is the DEEPEST
   * directory. The merge follows the cache only — a never-expanded dir
   * (listing unknown) renders under its own name until expanded. A dir
   * with files or multiple children never merges.
   */
  const rows = computed<ExplorerRow[]>(() => {
    const out: ExplorerRow[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const entry of children.value.get(dir) ?? []) {
        let deep = entry;
        let displayName = entry.name;
        if (entry.type === 'dir') {
          for (;;) {
            const listing = children.value.get(deep.path);
            if (listing === undefined || listing.length !== 1 || listing[0].type !== 'dir') break;
            deep = listing[0];
            displayName = `${displayName}/${deep.name}`;
          }
        }
        if (!passesChangedOnly(deep)) continue;
        const isExpanded = deep.type === 'dir' && expanded.value.has(deep.path);
        out.push({
          entry: deep,
          displayName,
          depth,
          isExpanded,
          isLoading: loadingDirs.value.has(deep.path),
        });
        if (isExpanded) walk(deep.path, depth + 1);
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
    revealFile,
    clearSelection,
  };
});
