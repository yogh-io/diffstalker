/**
 * useWorktreeStore: the ONE answer to "what worktrees does this repo
 * have?", keyed by filesystem path.
 *
 * Every surface that needs worktree knowledge reads it here:
 *  - the header's project name and the worktree dropdown (the ACTIVE repo);
 *  - the repo picker's "Open on daemon" rows (grouping open repos into one
 *    row per project);
 *  - the repo picker's "Recent" rows (paths that are not open at all).
 *
 * Those three used to resolve it separately — two endpoints, three caches,
 * three lifetimes, no sharing — which is why the same project could read
 * differently in the trigger label, the dropdown, and the panel, and why
 * the panel's contents depended on how recently it had been opened. One
 * cache keyed by PATH removes that class of bug: a path is the identity
 * both endpoints agree on (repo ids only exist while a repo is open), so
 * an entry cannot be attributed to the wrong repo.
 *
 * Resolution rules:
 *  - `ensure` fetches what is unknown, stale, or previously failed, and
 *    dedups concurrent asks for the same path onto one request;
 *  - an entry is NEVER dropped once resolved. The open-repo set changing
 *    marks entries stale (see the generation note below) so they are
 *    re-read in the background, but the last good answer keeps rendering
 *    — otherwise every repo switch empties the picker's Recent list;
 *  - `refresh` forces a re-read where freshness matters (the dropdown's
 *    "edited N ago" and commits-ahead go stale while a panel sits closed).
 *
 * Consumers derive by path, so nothing can render another repo's data —
 * a switch of any kind (picker, worktree dropdown, follow mode, URL, an
 * SSE reconnect) is correct by construction, not by a fetch landing in
 * time.
 *
 * Project identity comes from git's MAIN worktree, never from path shape,
 * so every layout works the same: worktrees nested under the repo, parked
 * as siblings, a bare repo with worktrees around it, scattered anywhere,
 * or none at all. See toProject.
 */

import { computed, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import { useDaemonStore } from './daemon';
import { basename, parentDir } from '../utils/format';
import type { WorktreeInfo } from '@diffstalker/client';

/** A resolved worktree family: what every consumer renders from. */
export interface WorktreeProject {
  /** Deepest directory containing every worktree — the project identity. */
  root: string;
  /** Display name: basename of the root. */
  name: string;
  /** All worktrees, bare entries already dropped, most recent first. */
  worktrees: WorktreeInfo[];
}

export type WorktreeEntry =
  /** A request is in flight; nothing to render yet. */
  | { status: 'pending' }
  | { status: 'ready'; project: WorktreeProject }
  /** The daemon answered: this path is not (or is no longer) a worktree. */
  | { status: 'absent' }
  /** We could not ask (daemon down). Distinct from 'absent' — the path may
   *  be fine, so callers may still show it, and `ensure` retries it. */
  | { status: 'failed' };

/** Most recently active first; unknown activity sorts last. */
function byActivity(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return [...worktrees].sort(
    (a, b) => (b.lastActivity ?? -Infinity) - (a.lastActivity ?? -Infinity)
  );
}

/**
 * The project a worktree family belongs to, derived from git's MAIN
 * worktree — never from path shape.
 *
 * Grouping used to be "deepest common parent directory of all worktrees",
 * which quietly assumed worktrees live under (or beside) the repo. It
 * broke on any other layout: siblings like `…/proj` + `…/proj-fix` share
 * only their PARENT, so the project was named after whichever directory
 * the user keeps repos in — a property of one machine, not of the repo.
 *
 * The main worktree exists in every layout, so this is indifferent to all
 * of them: worktrees nested under the repo, parked as siblings, a bare
 * repo with worktrees around it, scattered anywhere, or none at all.
 *
 * `all` must include bare entries — in a bare setup the MAIN entry IS the
 * bare git dir, and dropping it first would lose the family's identity.
 */
function toProject(path: string, all: WorktreeInfo[]): WorktreeProject {
  const worktrees = byActivity(all.filter((w) => !w.isBare));
  const main = all.find((w) => w.isMain);
  // No main reported (an old daemon, or an empty list): the queried path
  // is the only honest identity we have.
  if (!main) return { root: path, name: basename(path), worktrees };
  if (!main.isBare) return { root: main.path, name: basename(main.path), worktrees };

  // A bare main is the git dir itself, which is not a useful name.
  // `…/proj/.bare` (hidden dir) -> the project is its parent, `…/proj`.
  // `…/proj.git` -> keep it as the identity, but name it `proj`.
  const base = basename(main.path);
  if (base.startsWith('.')) {
    const root = parentDir(main.path);
    return { root, name: basename(root), worktrees };
  }
  return { root: main.path, name: base.replace(/\.git$/, ''), worktrees };
}

export const useWorktreeStore = defineStore('worktrees', () => {
  const client = new DiffstalkerClient();
  const daemon = useDaemonStore();

  const entries = shallowRef(new Map<string, WorktreeEntry>());
  /** One request per path at a time; concurrent asks share it. */
  const inFlight = new Map<string, Promise<void>>();

  /**
   * Staleness is a GENERATION, not a wipe.
   *
   * Worktrees can change when the open-repo set changes, so what we know
   * has to be re-read at some point. Clearing the cache to force that was
   * wrong twice over: opening or closing a repo happens on every single
   * repo switch, so the picker re-resolved everything constantly, and
   * recents — which deliberately do not render until resolved — vanished
   * from the list each time until their lookups landed.
   *
   * So entries are never dropped. A generation bump marks them stale;
   * `ensure` re-reads stale entries in the background while the last good
   * answer stays on screen (stale-while-revalidate). Nothing blanks, and
   * a re-read costs one request per path.
   */
  let generation = 0;
  /** The generation each entry was resolved in. */
  const resolvedAt = new Map<string, number>();

  function setEntry(path: string, entry: WorktreeEntry): void {
    const next = new Map(entries.value);
    next.set(path, entry);
    entries.value = next;
  }

  function entryFor(path: string): WorktreeEntry | undefined {
    return entries.value.get(path);
  }

  /** The resolved project for a path, or null while unknown/unresolved. */
  function projectFor(path: string): WorktreeProject | null {
    const entry = entries.value.get(path);
    return entry?.status === 'ready' ? entry.project : null;
  }

  function load(path: string): Promise<void> {
    const existing = inFlight.get(path);
    if (existing) return existing;

    // A re-read keeps showing what we already have: going back to
    // 'pending' would blank the dropdown (and unfold the picker's rows)
    // for a round-trip every time a panel opens. Only a path we cannot
    // render yet gets the pending state.
    const known = entries.value.get(path);
    if (known === undefined || known.status === 'failed') {
      setEntry(path, { status: 'pending' });
    }
    const request = client
      .worktreesForPath(path)
      .then((list) => {
        // An empty list means the daemon looked and found nothing: the
        // path is not a worktree (a removed directory still in recents).
        // Bare entries are kept here — toProject needs them to identify
        // the family, and drops them from the switchable list itself.
        setEntry(
          path,
          list.length === 0
            ? { status: 'absent' }
            : { status: 'ready', project: toProject(path, list) }
        );
      })
      .catch(() => {
        setEntry(path, { status: 'failed' });
      })
      .finally(() => {
        resolvedAt.set(path, generation);
        inFlight.delete(path);
      });

    inFlight.set(path, request);
    return request;
  }

  /**
   * Resolve these paths. Skips what is already resolved AND current;
   * re-reads what is unknown, stale (a newer generation), or previously
   * failed — the daemon may be back. A re-read never blanks what is
   * already on screen.
   */
  function ensure(paths: readonly string[]): Promise<void> {
    const wanted = paths.filter((path) => {
      const entry = entries.value.get(path);
      if (entry === undefined || entry.status === 'failed') return true;
      return (resolvedAt.get(path) ?? -1) < generation;
    });
    return Promise.all(wanted.map(load)).then(() => undefined);
  }

  /** Re-read these paths even when already resolved (freshness on demand). */
  function refresh(paths: readonly string[]): Promise<void> {
    return Promise.all(paths.map(load)).then(() => undefined);
  }

  /**
   * Mark everything stale: the next `ensure` re-reads it, but what is
   * already resolved keeps rendering until the fresh answer lands.
   */
  function markStale(): void {
    generation++;
  }

  /**
   * The active repo's own entry, kept resolved for the header (project
   * name + worktree dropdown). Watching the ACTIVE PATH — not the id —
   * means every kind of switch triggers exactly one resolution, and the
   * getters below key off that same path, so a switch can never leave the
   * previous repo's worktrees on screen.
   */
  const activePath = computed(
    () => daemon.repos.find((repo) => repo.id === daemon.activeRepoId)?.path ?? null
  );

  watch(
    activePath,
    (path) => {
      if (path !== null) void ensure([path]);
    },
    { immediate: true }
  );

  // The open-repo set changing is the one cheap signal that a worktree may
  // have been created or removed. Keyed on the PATHS, not the count:
  // swapping one repo for another leaves the count identical but can
  // change every family. This only marks stale — see the generation note.
  watch(
    () => daemon.repos.map((repo) => repo.path).join('\n'),
    () => markStale()
  );

  /** The active repo's project, or null until it resolves. */
  const activeProject = computed(() =>
    activePath.value === null ? null : projectFor(activePath.value)
  );

  return {
    entries,
    activePath,
    activeProject,
    entryFor,
    projectFor,
    ensure,
    refresh,
    markStale,
  };
});
