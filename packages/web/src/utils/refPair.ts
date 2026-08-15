/**
 * The two refs a diff is BETWEEN, named in the reader's words.
 *
 * Every diff surface in this app already fixes a ref pair — Changes
 * compares the index against the working tree, Compare a merge-base
 * against HEAD, History a commit against its parent — and until now not
 * one of them said so. The reader was left to infer it from which tab
 * they were on. That is the whole reason "what am I comparing against"
 * felt unanswerable: not that it could not be chosen, but that the app
 * never told you what it had already chosen.
 *
 * So the vocabulary lives HERE, in one place, rather than as a string
 * built at each of the four call sites — four copies would drift, and
 * "index → working tree" meaning the same thing everywhere is the entire
 * point. Surfaces describe their pair structurally; this turns it into
 * text.
 *
 * Deliberately NOT a ref picker. There is no input, nothing is editable,
 * and no arbitrary revspec can be expressed — see docs/whole-file-mode.md.
 */

import type { FileStatus } from '@diffstalker/core/git/status';

/** A diff's two sides, described structurally by the surface showing it. */
export type RefPair =
  /** Changes: one row of the working tree, either side of the index. */
  | { kind: 'working'; staged: boolean; status: FileStatus }
  /** Compare: the branch's own commits, base…HEAD (three-dot). */
  | { kind: 'compare'; base: string | null }
  /** Compare: the uncommitted rows, which sit against HEAD instead. */
  | { kind: 'compare-uncommitted' }
  /** History: what one commit changed, against its parent. */
  | { kind: 'commit'; shortHash: string }
  /** Journal: every entry is worktree-vs-HEAD by construction. */
  | { kind: 'journal' };

/** U+2192 RIGHTWARDS ARROW — the direction of the change, old to new. */
const ARROW = '→';

/**
 * One line of text for a pair. Kept short enough to sit inline in a file
 * header that already carries a status letter, a path, two or three
 * buttons and the +/- counts.
 */
export function refPairLabel(pair: RefPair): string {
  switch (pair.kind) {
    case 'working':
      // An untracked file has no old side at all, and a deleted one has no
      // new side. Saying "index → working tree" for either would name a
      // side that does not exist.
      if (pair.status === 'untracked') return `new file ${ARROW} working tree`;
      if (pair.status === 'deleted') {
        return pair.staged ? `HEAD ${ARROW} deleted` : `index ${ARROW} deleted`;
      }
      return pair.staged ? `HEAD ${ARROW} index` : `index ${ARROW} working tree`;
    case 'compare':
      // Three dots, not an arrow: this is base…HEAD, the branch's own
      // commits, and the dots are git's own notation for it.
      return pair.base === null ? 'base…HEAD' : `${pair.base}…HEAD`;
    case 'compare-uncommitted':
      // A DIFFERENT base from the committed rows in the same stack, which
      // is exactly why this is worth printing.
      return `HEAD ${ARROW} working tree`;
    case 'commit':
      return `${pair.shortHash}^ ${ARROW} ${pair.shortHash}`;
    case 'journal':
      return `HEAD ${ARROW} working tree`;
  }
}

/** The longer explanation, for the title attribute. */
export function refPairTitle(pair: RefPair): string {
  switch (pair.kind) {
    case 'working':
      if (pair.status === 'untracked') return 'A new file: every line is an addition';
      if (pair.status === 'deleted') return 'The file was deleted; every line is a removal';
      return pair.staged
        ? 'What you have staged: HEAD compared against the index'
        : 'What you have not staged yet: the index compared against the file on disk';
    case 'compare':
      return 'Everything this branch adds on top of its base (three-dot diff)';
    case 'compare-uncommitted':
      return 'Uncommitted work, compared against HEAD — not against the compare base';
    case 'commit':
      return 'What this commit changed, against its parent';
    case 'journal':
      return 'The working tree compared against HEAD';
  }
}
