/**
 * Journal route: the append-only, hunk-granular edit chronology.
 *
 * GET /repos/:id/journal?since=<seq> -> { epoch, prunedBefore, entries }
 * where entries are those with seq > since (all when since is omitted).
 * Read-only: entries are appended daemon-side by JournalManager as the
 * working tree is observed and stream to clients as `journal-append`
 * events on the per-repo SSE channel; this endpoint is the catch-up /
 * initial-load path. The store outlives the repo's manager (see
 * repoRegistry's JournalStoreCache), so a close + reopen serves the same
 * chronology under the same epoch.
 */

import { Router, HttpError, sendJson } from '../router.js';
import { serializeJournal } from '../serialize.js';
import { requireRepo, type RouteDeps } from './shared.js';

/**
 * Parse the `since` query param: a non-negative integer seq; absent means
 * 0 (everything). Seqs start at 1, so 0 never filters anything out.
 * Digits only — Number() would silently coerce '' (0), '1e2' (100), and
 * '0x10' (16), none of which is a seq a client legitimately sends.
 */
function parseSinceParam(query: URLSearchParams): number {
  const raw = query.get('since');
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `Invalid "since" (expected a non-negative integer): ${raw}`);
  }
  return Number(raw);
}

export function registerJournalRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.get('/repos/:id/journal', ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const since = parseSinceParam(query);
    sendJson(res, 200, serializeJournal(handle.manager.journal.journalStore, since));
  });
}
