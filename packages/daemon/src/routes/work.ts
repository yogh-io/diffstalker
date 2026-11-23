/**
 * The Work page (docs/work-page.md §5): one repo's facts, the author's PRs
 * from `gh`, and the page's marks. The page scans when it is opened and
 * when its refresh button is pressed; nothing here runs on its own.
 *
 * `POST /work/prs/refresh` and `POST /work/repo` are POST, and that is not
 * a style choice. `security.ts` applies its CSRF check to non-GET requests
 * only. The refresh spawns `gh`, which sends the author's token over the
 * network. The repo route runs a full git scan, so as a GET any website
 * could start scans and time them (the same reasoning as search,
 * docs/search-design.md). Do not "correct" either to a GET.
 *
 * One scan per repo family runs at a time and a request while it runs joins
 * it, so repeated requests cannot queue up scans behind the page's own.
 * Discovery can list a worktree of a repo it also lists; that path shares
 * the repo's scan.
 *
 * Registered for both API modes: the web UI is the client this exists for.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGitDirs } from '@diffstalker/core/git/worktree';
import { scanWorkRepo } from '@diffstalker/core/git/workScan';
import type { WorkRepoFacts } from '@diffstalker/core/types/work';
import { Router, HttpError, sendJson } from '../router.js';
import { parseMarkRequest } from '../workMarks.js';
import { requireStringField, type RouteDeps } from './shared.js';

/** Repo paths the daemon already knows: discovered under a watch directory, or open. */
function knownRepoPaths(deps: RouteDeps): Set<string> {
  const known = new Set<string>();
  for (const root of deps.discovery.state.roots) {
    for (const repo of root.repos) known.add(repo.path);
  }
  for (const handle of deps.registry.listRepos()) known.add(handle.path);
  return known;
}

export type WorkScanner = (repoPath: string) => Promise<WorkRepoFacts | null>;

/**
 * How long a finished scan still answers the other paths of its repo. The
 * page asks 4 at a time in discovery order, so two paths of one repo can
 * be asked up to a whole page scan apart: 1.1 to 3.2 s for 84 repos.
 */
export const FAMILY_REUSE_MS = 5000;

/**
 * The repo a path belongs to: the real path of its common git dir, the
 * same for every worktree. Fs only. Null when the path has no `.git`.
 */
export function repoFamily(repoPath: string): string | null {
  const dirs = resolveGitDirs(repoPath);
  if (dirs === null) return null;
  try {
    return fs.realpathSync(dirs.commonDir);
  } catch {
    // A `.git` that points nowhere: no family, and the scan says what is wrong.
    return null;
  }
}

interface FamilyScan {
  facts: Promise<WorkRepoFacts | null>;
  done: boolean;
  /** The paths it answered: asking for one of them again is a new refresh. */
  answered: Set<string>;
}

/**
 * One scan per repo family. A call joins the family's scan while it runs,
 * and for FAMILY_REUSE_MS after it, for a path that scan has not answered
 * yet. Each answer carries the path it was asked for.
 */
export function createWorkScanner(
  scan: WorkScanner = scanWorkRepo,
  familyOf: (repoPath: string) => string | null = repoFamily,
  reuseMs = FAMILY_REUSE_MS
): WorkScanner {
  const scans = new Map<string, FamilyScan>();
  function start(family: string, repoPath: string): FamilyScan {
    const entry: FamilyScan = { facts: scan(repoPath), done: false, answered: new Set() };
    scans.set(family, entry);
    const forget = () => {
      if (scans.get(family) === entry) scans.delete(family);
    };
    entry.facts.then(() => {
      entry.done = true;
      setTimeout(forget, reuseMs).unref();
    }, forget);
    return entry;
  }
  return async (repoPath) => {
    const family = familyOf(repoPath) ?? repoPath;
    let entry = scans.get(family);
    if (entry === undefined || (entry.done && entry.answered.has(repoPath))) {
      entry = start(family, repoPath);
    }
    entry.answered.add(repoPath);
    const facts = await entry.facts;
    return facts === null ? null : { ...facts, path: repoPath };
  };
}

export function registerWorkRoutes(router: Router, deps: RouteDeps, scanWork: WorkScanner): void {
  const { prs, workMarks } = deps;

  router.post('/work/repo', async ({ body, res }) => {
    const requested = requireStringField(body, 'path');
    if (!path.isAbsolute(requested)) {
      throw new HttpError(400, `Repo path must be absolute: ${requested}`);
    }
    const repoPath = path.resolve(requested);
    // Only a repo the daemon already lists: this runs git, and a page
    // must not point it at any path it likes.
    if (!knownRepoPaths(deps).has(repoPath)) {
      throw new HttpError(404, `Not a discovered or open repo: ${repoPath}`);
    }
    let facts;
    try {
      facts = await scanWork(repoPath);
    } catch (err) {
      throw new HttpError(500, `Could not scan ${repoPath}`, { cause: err });
    }
    if (facts === null) throw new HttpError(404, `Not a git repository: ${repoPath}`);
    sendJson(res, 200, facts);
  });

  router.get('/work/prs', ({ res }) => {
    sendJson(res, 200, prs.snapshot());
  });

  router.post('/work/prs/refresh', async ({ res }) => {
    sendJson(res, 200, await prs.refresh());
  });

  router.get('/work/marks', ({ res }) => {
    sendJson(res, 200, workMarks.load());
  });

  router.put('/work/marks', ({ body, res }) => {
    const request = parseMarkRequest(body);
    let marks;
    try {
      marks = workMarks.apply(request, Date.now());
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(500, `Could not save marks: ${reason}`, { cause: err });
    }
    sendJson(res, 200, marks);
  });
}
