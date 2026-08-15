/**
 * buildRepoRows: the ONE function that turns everything the repo picker
 * knows — repos open on the daemon, recents, discovered repos, the query,
 * the expand toggle — into the flat list of rows it draws.
 *
 * One array, built once per render. Rendering, the keyboard index, the
 * "Show N discovered repos" count and every test read the same array, so
 * they cannot disagree about what row 4 is. The picker used to be three
 * templates counting three lists independently; a merged list with a
 * keyboard rail cannot afford that.
 *
 * Pure: no stores, no Vue, no clock. Everything it needs is an argument
 * (`now` included), so its whole behaviour is unit-testable without a DOM.
 * Matching lives in here too, rather than in the component, because the
 * path-to-haystack mapping and the row it belongs to must be decided in one
 * place — the highlight positions a row carries are only correct if they
 * came from the same string the row renders.
 */

import { createFinderIndex } from '@diffstalker/core/view/finderModel';
import type { DiscoveredRepo, RepoSummary } from '@diffstalker/client';

/** A project with worktrees open on the daemon, folded to one row. */
export interface OpenProject {
  /** Project root: git's main worktree, via the worktree store. */
  root: string;
  name: string;
  /** The open worktrees of this project (one repo id each). */
  repos: RepoSummary[];
  /** ALL worktrees the project has, not just the open ones. */
  worktreeCount: number;
  /**
   * Every worktree path of the resolved family, root included. This is
   * what keeps a bare layout honest: discovery finds each sibling worktree
   * as its own repo, so without the family the same project renders as one
   * OPEN row AND a discovered row per sibling.
   */
  familyPaths: string[];
}

/** A recently-visited project that is not open on the daemon. */
export interface RecentProject {
  root: string;
  name: string;
  worktreeCount: number;
  familyPaths: string[];
  /** The path to open: the family's freshest worktree, or the root. */
  openPath: string;
}

export interface RepoRowsInput {
  openProjects: OpenProject[];
  recentProjects: RecentProject[];
  discovered: DiscoveredRepo[];
  /** Repo id of the active repo, so its project row can be marked. */
  activeRepoId: string | null;
  /** The query as typed, already trimmed. */
  query: string;
  /** Whether the discovered section has been revealed. */
  expanded: boolean;
  /** False when the daemon is unreachable: the reveal control hides. */
  connected: boolean;
  /** True when a watch root hit the scan cap, so the label can say so. */
  capped: boolean;
  /** Now, in epoch ms — for the stale test. Injected, never read here. */
  now: number;
}

interface RowBase {
  /** Stable across rebuilds: the selection is stored by key, not index. */
  key: string;
  name: string;
  path: string;
  /** Matched character indices into `path`, for the highlight. */
  positions: ReadonlySet<number>;
}

export type PickerRow =
  | { kind: 'section'; key: string; label: string }
  | (RowBase & { kind: 'open'; project: OpenProject; active: boolean })
  | (RowBase & { kind: 'recent'; project: RecentProject })
  | (RowBase & {
      kind: 'discovered';
      branch: string | null;
      lastActivity: number | null;
      stale: boolean;
    })
  | { kind: 'more'; key: 'more'; label: string };

/** Rows the keyboard can land on. Eyebrows are not among them. */
export type SelectableRow = Exclude<PickerRow, { kind: 'section' }>;

/** A row standing for an actual repository — everything but the furniture. */
export type RepoRow = Exclude<PickerRow, { kind: 'section' } | { kind: 'more' }>;

export function isSelectable(row: PickerRow): row is SelectableRow {
  return row.kind !== 'section';
}

/**
 * How long a project can go untouched before its row recedes. Past this it
 * is still there, still one click away — it just stops competing for the
 * eye with the ones being worked on. Six months is deliberately generous: a
 * project you return to seasonally should not read as abandoned.
 */
export const STALE_AFTER_MS = 182 * 24 * 60 * 60 * 1000;

/** Unknown activity counts as stale: it is certainly not evidence of freshness. */
function isStale(lastActivity: number | null, now: number): boolean {
  return lastActivity === null || now - lastActivity > STALE_AFTER_MS;
}

export function buildRepoRows(input: RepoRowsInput): PickerRow[] {
  const { openProjects, query, expanded, connected, capped, now } = input;

  // --- Dedup, before any matching -----------------------------------------
  //
  // Open beats recent (by project root); both beat discovered (by every
  // path in their families). Order matters: the discovered exclusion set is
  // built from the recents that SURVIVED, not from every recent path.

  const openRoots = new Set(openProjects.map((project) => project.root));
  const recentProjects = input.recentProjects.filter((project) => !openRoots.has(project.root));

  const covered = new Set<string>();
  for (const project of [...openProjects, ...recentProjects]) {
    covered.add(project.root);
    for (const path of project.familyPaths) covered.add(path);
  }
  for (const project of openProjects) {
    for (const repo of project.repos) covered.add(repo.path);
  }
  const discovered = input.discovered.filter((repo) => !covered.has(repo.path));

  // --- Matching ------------------------------------------------------------
  //
  // One haystack per candidate row: its PATH, which contains the name as
  // its basename, so typing either finds the row. The index is built over
  // every candidate at once so a single fzf pass answers for all three
  // sections; the surviving set is then applied per section, which is what
  // keeps each section in its SOURCE order (recency, activity) instead of
  // fzf's score order.

  const candidatePaths = [
    ...openProjects.map((project) => project.root),
    ...recentProjects.map((project) => project.root),
    ...discovered.map((repo) => repo.path),
  ];
  const index = createFinderIndex(candidatePaths, candidatePaths.length);
  const matches = new Map(index.find(query).map((match) => [match.text, match.positions]));

  const rows: PickerRow[] = [];

  function section(label: string, count: number): void {
    if (count > 0) rows.push({ kind: 'section', key: `section:${label}`, label });
  }

  // --- OPEN ---------------------------------------------------------------

  const openRows = openProjects.flatMap((project): PickerRow[] => {
    const positions = matches.get(project.root);
    if (!positions) return [];
    return [
      {
        kind: 'open',
        key: `open:${project.root}`,
        name: project.name,
        path: project.root,
        positions,
        project,
        active: project.repos.some((repo) => repo.id === input.activeRepoId),
      },
    ];
  });
  // Every section with rows gets its eyebrow, including a lone one: OPEN is
  // the "special label" that says these repos are already live on the
  // daemon, and one section is exactly when a reader most needs telling
  // which one it is.
  section('Open', openRows.length);
  rows.push(...openRows);

  // --- RECENT -------------------------------------------------------------

  const recentRows = recentProjects.flatMap((project): PickerRow[] => {
    const positions = matches.get(project.root);
    if (!positions) return [];
    return [
      {
        kind: 'recent',
        key: `recent:${project.root}`,
        name: project.name,
        path: project.root,
        positions,
        project,
      },
    ];
  });
  section('Recent', recentRows.length);
  rows.push(...recentRows);

  // --- DISCOVERED ---------------------------------------------------------
  //
  // Hidden by default. A query reaches them without the toggle, because
  // "type a name and it is found" is worth more than the tidiness of the
  // default list — and the alternative is a search that silently misses
  // most of the machine's repos.

  const discoveredVisible = query !== '' || expanded;
  const discoveredRows = discoveredVisible
    ? discovered.flatMap((repo): PickerRow[] => {
        const positions = matches.get(repo.path);
        if (!positions) return [];
        return [
          {
            kind: 'discovered',
            key: `discovered:${repo.path}`,
            name: repo.name,
            path: repo.path,
            positions,
            branch: repo.branch,
            lastActivity: repo.lastActivity,
            stale: isStale(repo.lastActivity, now),
          },
        ];
      })
    : [];
  section('Discovered', discoveredRows.length);
  rows.push(...discoveredRows);

  // --- The reveal control -------------------------------------------------
  //
  // Never while filtering: typing already searches discovered repos, so the
  // control would be a second way to do what just happened. Once expanded
  // it stays rendered whatever the connection does — a disconnect that hid
  // it would strand the user expanded with no way back.

  if (query === '' && (expanded || (connected && discovered.length > 0))) {
    rows.push({ kind: 'more', key: 'more', label: moreLabel(expanded, discovered.length, capped) });
  }

  return rows;
}

/**
 * The count is what revealing will ACTUALLY add (post-dedup), not the raw
 * scan size. A capped scan says so here rather than in a separate note, so
 * a truncated list is never presented as complete.
 */
function moreLabel(expanded: boolean, count: number, capped: boolean): string {
  if (expanded) return 'Hide discovered repos';
  const suffix = capped ? '+ discovered repos (list incomplete)' : ' discovered repos';
  return `Show ${count}${suffix}`;
}
