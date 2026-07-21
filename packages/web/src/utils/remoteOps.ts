/**
 * Labels for the remote-operation progress machine and the wedged
 * (mid-rebase/cherry-pick/revert/merge) repo states — the web port of
 * the CLI header's label table. One source so the header status, the
 * actions menu, and the operation banner all speak identically.
 */

import type { RemoteOperation } from '@diffstalker/core/types/remote';
import type { InProgressOperation } from '@diffstalker/core/git/status';

/** In-flight label per remote operation ("pushing…", "stashing…"). */
export const REMOTE_OP_LABELS: Record<RemoteOperation, string> = {
  push: 'pushing…',
  fetch: 'fetching…',
  pull: 'pulling…',
  stash: 'stashing…',
  stashPop: 'popping stash…',
  branchSwitch: 'switching branch…',
  branchCreate: 'creating branch…',
  softReset: 'resetting…',
  cherryPick: 'cherry-picking…',
  revert: 'reverting…',
  abort: 'aborting…',
  rebaseContinue: 'continuing rebase…',
};

/** What the repo is stopped in, for the wedged-op banner. */
export const IN_PROGRESS_LABELS: Record<InProgressOperation, string> = {
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  merge: 'merge',
};

/**
 * Condense a git error for display: a conflicted cherry-pick/pull comes
 * back as git's full multi-line stderr, most of it "hint:" advice for a
 * SHELL user ("run git cherry-pick --abort") that the UI's own banner
 * buttons replace. Keep the substantive lines, drop the hint spam, and
 * collapse to one line for the inline slots. The full raw text stays
 * available via the element's title.
 */
export function condenseGitError(error: string): string {
  const lines = error
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('hint:'));
  // All-hint stderr would condense to '' and the error slot would
  // vanish — fall back to the original text so an error always shows.
  return lines.join(' — ') || error.trim() || error;
}
