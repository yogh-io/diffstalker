/**
 * useSettingsStore: the DAEMON's settings and the repos they discover.
 *
 * Not to be confused with prefs.ts, which is this browser's taste (theme,
 * splits, toggles) in localStorage. What lives here is machine state the
 * daemon owns: which directories to scan for projects, and what was found
 * in them. Every client sees the same values, and they survive a reload,
 * a different browser, and a daemon restart.
 *
 * Reads are pulled once on connect and then kept fresh by the daemon-scope
 * SSE events (`settings-change`, `discovery-change`), which the daemon
 * store forwards here — so a save in one tab, or a clone appearing on
 * disk, updates every open tab without polling.
 */

import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import type { DaemonSettings, DiscoveredRepo, DiscoveryState } from '@diffstalker/client';
import { errorMessage } from '../api/errors';

export const useSettingsStore = defineStore('settings', () => {
  const client = new DiffstalkerClient();

  const watchRoots = shallowRef<string[]>([]);
  /**
   * False when the daemon holds settings in memory only. The panel says
   * so rather than implying a save that will not outlive the daemon.
   */
  const persisted = shallowRef(true);
  const roots = shallowRef<DiscoveryState['roots']>([]);
  /** True while a save is in flight — the form disables itself. */
  const saving = shallowRef(false);
  /** The daemon's reason for refusing the last save, shown in the form. */
  const saveError = shallowRef<string | null>(null);
  /** True once the first load answered, so the panel can hold off drawing. */
  const loaded = shallowRef(false);

  /**
   * Every discovered repo across all roots, deduped by path (two watch
   * directories can overlap) and ordered MOST RECENTLY TOUCHED FIRST.
   *
   * Not alphabetical: a projects folder collects years of them, and the
   * three you are working on this week are the answer to "which repo" in
   * almost every case. Sorting by name buries those under whatever
   * happens to start with an "a". A repo whose activity could not be read
   * sorts last rather than first — unknown is not fresh — and ties fall
   * back to the name so the order is stable.
   */
  const discoveredRepos = computed<DiscoveredRepo[]>(() => {
    const byPath = new Map<string, DiscoveredRepo>();
    for (const root of roots.value) {
      for (const repo of root.repos) {
        if (!byPath.has(repo.path)) byPath.set(repo.path, repo);
      }
    }
    return [...byPath.values()].sort(
      (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.name.localeCompare(b.name)
    );
  });

  /** Roots the daemon could not scan, for the panel's inline warnings. */
  const failedRoots = computed(() => roots.value.filter((root) => root.error !== null));

  function applySettings(settings: DaemonSettings): void {
    watchRoots.value = settings.watchRoots;
    persisted.value = settings.persisted;
  }

  function applyDiscovery(state: DiscoveryState): void {
    roots.value = state.roots;
  }

  /**
   * Pull both documents. Best-effort and silent: this feeds a panel the
   * user may never open, so a failure leaves the last known values and
   * lets the daemon store own the connection status.
   */
  async function load(): Promise<void> {
    try {
      const [settings, discovery] = await Promise.all([client.getSettings(), client.discovered()]);
      applySettings(settings);
      applyDiscovery(discovery);
      loaded.value = true;
    } catch {
      // Nothing to say here; the status bar already shows a dead daemon.
    }
  }

  /**
   * Save a new list of watch directories. Returns true when the daemon
   * took it; on refusal the reason lands in saveError and the stored list
   * is left exactly as it was, so the panel never shows a root that was
   * not accepted.
   */
  async function saveWatchRoots(next: string[]): Promise<boolean> {
    saving.value = true;
    saveError.value = null;
    try {
      applySettings(await client.setWatchRoots(next));
      // The daemon scans before it replies, so this is the new state, not
      // a race against it.
      applyDiscovery(await client.discovered());
      return true;
    } catch (err) {
      saveError.value = errorMessage(err);
      return false;
    } finally {
      saving.value = false;
    }
  }

  /**
   * The daemon drops a repeat silently — two spellings of one directory
   * (`~/gitRepos`, `/home/j/gitRepos/`) normalize to the same path and
   * `normalizeWatchRoots` skips it — so a no-op save is indistinguishable
   * from a real one: the field just clears and nothing appears. Compare
   * what came back with what we sent and say so.
   *
   * Compared AFTER the save, not against the typed string before it, so
   * every spelling is caught: the daemon has already normalized by then.
   * Sound because normalizing only ever drops entries, never adds them.
   */
  async function addWatchRoot(path: string): Promise<boolean> {
    const before = watchRoots.value;
    const ok = await saveWatchRoots([...before, path]);
    if (ok && watchRoots.value.length === before.length) {
      saveError.value = `Already watching ${path}`;
      return false;
    }
    return ok;
  }

  /** Drop a refusal from a previous visit — the panel opens clean. */
  function clearSaveError(): void {
    saveError.value = null;
  }

  function removeWatchRoot(path: string): Promise<boolean> {
    return saveWatchRoots(watchRoots.value.filter((root) => root !== path));
  }

  /**
   * Re-walk the roots now. The watcher does not see inside a repo's .git,
   * so this is how a branch label catches up after a checkout somewhere
   * else — cheap enough to call when a panel opens (no git processes).
   */
  async function rescan(): Promise<void> {
    try {
      applyDiscovery(await client.rescanDiscovered());
    } catch {
      // Keep what we had; the panel is not worth an error line for this.
    }
  }

  return {
    watchRoots,
    persisted,
    roots,
    saving,
    saveError,
    loaded,
    discoveredRepos,
    failedRoots,
    applySettings,
    applyDiscovery,
    load,
    saveWatchRoots,
    clearSaveError,
    addWatchRoot,
    removeWatchRoot,
    rescan,
  };
});
