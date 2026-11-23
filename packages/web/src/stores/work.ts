/**
 * useWorkStore: the Work page's data (docs/work-page.md §5). The daemon
 * serves facts per repo, the PR snapshot and the marks; core's
 * classifyWork decides where each item goes, here in the browser.
 *
 * The page scans when it opens, when it is shown again (catchUp: the tab
 * becomes visible or the window gets focus) and when the refresh button
 * is pressed, never on a timer. Shown again, it asks only for what is
 * older than its minimum age: the repos after LOCAL_MAX_AGE_MS, GitHub
 * after GITHUB_MAX_AGE_MS. A scan lists the discovered repos (phase 1) and then
 * the open repos that phase 1 did not already cover as a worktree
 * (phase 2), at most WORK_SCAN_CONCURRENCY requests at a time, and shows
 * each answer as it lands. A newer scan drops an older one.
 *
 * Marks whose item is gone are pruned only after a complete scan: every
 * watch directory was listed in full, every repo answered and the PR list
 * is a real GitHub answer.
 */

import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { DiscoveryState } from '@diffstalker/client';
import { DiffstalkerClient } from '../api/client';
import { errorMessage } from '../api/errors';
import { logDaemonRefusal, logFailure } from './failureLog';
import { classifyWork } from '@diffstalker/core/view/workModel';
import { WORK_SCAN_CONCURRENCY } from '@diffstalker/core/types/work';
import type {
  PrSnapshot,
  WorkMarkAction,
  WorkMarkRequest,
  WorkMarks,
  WorkRepoFacts,
} from '@diffstalker/core/types/work';

/** Shown again, the repos are scanned again when the last scan ended longer ago than this. */
export const LOCAL_MAX_AGE_MS = 60 * 1000;
/** Opened or shown again, GitHub is asked again when the PR list is older than this. */
export const GITHUB_MAX_AGE_MS = 5 * 60 * 1000;

/** The snapshot before the daemon was asked. */
export const NEVER_CHECKED: PrSnapshot = {
  status: 'never',
  message: null,
  checkedAt: null,
  viewer: null,
  prs: [],
  capped: false,
};

export interface WorkScanProgress {
  total: number;
  done: number;
  running: boolean;
}

export interface WorkRepoError {
  path: string;
  message: string;
}

/** Run `task` over `items`, at most `limit` at a time. `task` must not reject. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Why each watch directory the daemon could not list in full may be missing repos. */
function rootErrorsOf(discovery: DiscoveryState): WorkRepoError[] {
  return discovery.roots.flatMap((root) => {
    if (root.error !== null) return [{ path: root.path, message: root.error }];
    if (root.capped) return [{ path: root.path, message: 'more repos than listed' }];
    return [];
  });
}

function withRepo(list: readonly WorkRepoFacts[], facts: WorkRepoFacts): WorkRepoFacts[] {
  const index = list.findIndex((repo) => repo.root === facts.root);
  if (index === -1) return [...list, facts];
  const next = [...list];
  next[index] = facts;
  return next;
}

export const useWorkStore = defineStore('work', () => {
  const client = new DiffstalkerClient();

  /** One entry per repo root. */
  const repos = shallowRef<WorkRepoFacts[]>([]);
  const scan = shallowRef<WorkScanProgress>({ total: 0, done: 0, running: false });
  /** The last scan reached its end. */
  const scanFinished = shallowRef(false);
  const repoErrors = shallowRef<WorkRepoError[]>([]);
  /** Watch directories that failed or hit their cap: repos under them may be missing. */
  const rootErrors = shallowRef<WorkRepoError[]>([]);
  /**
   * Every watch directory listed at least one repo, and none failed or hit
   * its cap. One that lists nothing may not be walked yet (the daemon walks
   * them after it starts), so that too keeps marks from being pruned.
   */
  const rootsComplete = shallowRef(false);
  const prs = shallowRef<PrSnapshot | null>(null);
  const prsLoading = shallowRef(false);
  const marks = shallowRef<WorkMarks>({ tracked: {}, dismissed: {} });
  /** One line for a request the page itself could not make. */
  const error = shallowRef<string | null>(null);
  /** The clock classifyWork judges the 7-day window by; moves whenever a scan or check starts. */
  const now = shallowRef(Date.now());
  /** When the last scan finished, epoch ms; null before the first. */
  const scannedAt = shallowRef<number | null>(null);

  let generation = 0;

  const complete = computed(
    () =>
      scanFinished.value &&
      rootsComplete.value &&
      repoErrors.value.length === 0 &&
      !prsLoading.value &&
      prs.value !== null &&
      prs.value.checkedAt !== null
  );

  const classification = computed(() =>
    classifyWork(repos.value, prs.value ?? NEVER_CHECKED, marks.value, now.value, complete.value)
  );

  function fail(operation: string, err: unknown, line: string): void {
    logFailure(operation, err);
    error.value = `${line}: ${errorMessage(err)}`;
  }

  async function loadMarks(): Promise<void> {
    try {
      marks.value = await client.workMarks();
    } catch (err) {
      fail('load Work marks', err, 'Could not load marks');
    }
  }

  /** The PR list is missing or older than GITHUB_MAX_AGE_MS. */
  function prsStale(snapshot: PrSnapshot | null): boolean {
    if (snapshot === null || snapshot.status === 'never' || snapshot.checkedAt === null)
      return true;
    return Date.now() - snapshot.checkedAt > GITHUB_MAX_AGE_MS;
  }

  /** The cached snapshot; GitHub is asked only when it is missing or old (doc §4.2). */
  async function loadPrs(): Promise<void> {
    prsLoading.value = true;
    try {
      const cached = await client.workPrs();
      prs.value = cached;
      if (prsStale(cached)) prs.value = await client.refreshWorkPrs();
    } catch (err) {
      fail('load PRs', err, 'Could not load PRs');
    } finally {
      prsLoading.value = false;
    }
  }

  async function refreshPrs(): Promise<void> {
    prsLoading.value = true;
    try {
      prs.value = await client.refreshWorkPrs();
    } catch (err) {
      fail('check PRs', err, 'Could not check PRs');
    } finally {
      prsLoading.value = false;
    }
  }

  async function scanOne(
    path: string,
    gen: number,
    found: Map<string, WorkRepoFacts>
  ): Promise<void> {
    try {
      const facts = await client.workRepo(path);
      if (gen !== generation || found.has(facts.root)) return;
      found.set(facts.root, facts);
      repos.value = withRepo(repos.value, facts);
    } catch (err) {
      if (gen !== generation) return;
      logDaemonRefusal('scan repo for the Work page', err, { path });
      repoErrors.value = [...repoErrors.value, { path, message: errorMessage(err) }];
    } finally {
      if (gen === generation) scan.value = { ...scan.value, done: scan.value.done + 1 };
    }
  }

  /** Rescan every discovered and open repo. Results show as they land. */
  async function runScan(): Promise<void> {
    generation += 1;
    const gen = generation;
    scanFinished.value = false;
    repoErrors.value = [];
    rootErrors.value = [];
    rootsComplete.value = false;
    scan.value = { total: 0, done: 0, running: true };

    let discovery: DiscoveryState;
    let openPaths: string[];
    try {
      const [listed, open] = await Promise.all([client.discovered(), client.listRepos()]);
      discovery = listed;
      openPaths = open.map((repo) => repo.path);
    } catch (err) {
      if (gen !== generation) return;
      fail('list repos for the Work page', err, 'Could not list repos');
      scan.value = { ...scan.value, running: false };
      return;
    }
    if (gen !== generation) return;
    rootErrors.value = rootErrorsOf(discovery);
    rootsComplete.value = discovery.roots.every(
      (root) => root.error === null && !root.capped && root.repos.length > 0
    );
    const discoveredPaths = [
      ...new Set(discovery.roots.flatMap((root) => root.repos.map((r) => r.path))),
    ];

    const found = new Map<string, WorkRepoFacts>();
    scan.value = { total: discoveredPaths.length, done: 0, running: true };
    await runPool(discoveredPaths, WORK_SCAN_CONCURRENCY, (path) => scanOne(path, gen, found));
    if (gen !== generation) return;

    const covered = new Set(discoveredPaths);
    for (const facts of found.values()) {
      for (const worktree of facts.worktrees) covered.add(worktree.path);
    }
    const rest = [...new Set(openPaths)].filter((path) => !covered.has(path));
    scan.value = { ...scan.value, total: discoveredPaths.length + rest.length };
    await runPool(rest, WORK_SCAN_CONCURRENCY, (path) => scanOne(path, gen, found));
    if (gen !== generation) return;

    // Drop repos the last scan had and this one did not find.
    repos.value = [...found.values()];
    scan.value = { ...scan.value, running: false };
    scanFinished.value = true;
    scannedAt.value = Date.now();
  }

  /** The page opened. */
  async function load(): Promise<void> {
    now.value = Date.now();
    error.value = null;
    await Promise.all([loadMarks(), loadPrs(), runScan()]);
  }

  /**
   * The page was shown again: scan the repos and ask GitHub, each only
   * when it is older than its minimum age and not already running.
   */
  async function catchUp(): Promise<void> {
    const at = Date.now();
    const local =
      !scan.value.running && (scannedAt.value === null || at - scannedAt.value > LOCAL_MAX_AGE_MS);
    const github = !prsLoading.value && prsStale(prs.value);
    if (!local && !github) return;
    now.value = at;
    await Promise.all([github ? refreshPrs() : null, local ? runScan() : null]);
  }

  /** The refresh button: GitHub and every repo again. */
  async function refresh(): Promise<void> {
    now.value = Date.now();
    error.value = null;
    await Promise.all([refreshPrs(), runScan()]);
  }

  /** Track, dismiss, drop or undismiss one item; prunes stale marks in the same write. */
  async function mark(key: string, action: WorkMarkAction, fingerprint?: string): Promise<void> {
    const stale = classification.value.staleMarks.filter((staleKey) => staleKey !== key);
    const markRequest: WorkMarkRequest = { key, action };
    if (fingerprint !== undefined) markRequest.fingerprint = fingerprint;
    if (stale.length > 0) markRequest.prune = stale;
    try {
      marks.value = await client.putWorkMark(markRequest);
    } catch (err) {
      fail('save a Work mark', err, 'Could not save');
    }
  }

  return {
    repos,
    scan,
    scanFinished,
    repoErrors,
    rootErrors,
    prs,
    prsLoading,
    marks,
    error,
    now,
    scannedAt,
    complete,
    classification,
    load,
    catchUp,
    refresh,
    runScan,
    mark,
  };
});
