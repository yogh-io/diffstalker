/**
 * The two refs a diff is BETWEEN, named in the reader's words.
 *
 * Every diff surface in this app already fixes a ref pair — Changes
 * compares the index against the working tree, Compare a merge-base
 * against HEAD (or the index or working tree, with uncommitted work
 * folded in), History a commit against its parent — and until now not
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
import type { UncommittedSide } from '@diffstalker/core/types/compare';

/** A diff's two sides, described structurally by the surface showing it. */
export type RefPair =
  /** Changes: one row of the working tree, either side of the index. */
  | { kind: 'working'; staged: boolean; status: FileStatus }
  /**
   * Compare: the branch's own commits, base…head (three-dot). `head` is
   * the picked stack layer; null is HEAD, the checked-out branch.
   */
  | { kind: 'compare'; base: string | null; head: string | null }
  /**
   * Compare: a row that holds uncommitted work. It starts at the same
   * merge-base as every other row, and ends at the index when it holds
   * only staged work, or at the working tree once it holds unstaged or
   * untracked work.
   */
  | { kind: 'compare-uncommitted'; base: string | null; side: UncommittedSide }
  /** History: what one commit changed, against its parent. */
  | { kind: 'commit'; shortHash: string }
  /** Journal: every entry is worktree-vs-HEAD by construction. */
  | { kind: 'journal' };

/** U+2192 RIGHTWARDS ARROW — the direction of the change, old to new. */
const ARROW = '→';

/** Where a compare row that holds uncommitted work ends. */
function uncommittedTip(side: UncommittedSide): string {
  return side === 'staged' ? 'index' : 'working tree';
}

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
      // Three dots, not an arrow: this is base…head, the branch's own
      // commits, and the dots are git's own notation for it.
      return `${pair.base ?? 'base'}…${pair.head ?? 'HEAD'}`;
    case 'compare-uncommitted':
      // The same three dots: it starts where the committed rows start,
      // and only its end differs.
      return `${pair.base ?? 'base'}…${uncommittedTip(pair.side)}`;
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
      return pair.head === null
        ? 'Everything this branch adds on top of its base (three-dot diff)'
        : `Everything ${pair.head} adds on top of the layer below it (three-dot diff)`;
    case 'compare-uncommitted':
      return pair.side === 'staged'
        ? 'Everything this branch adds on top of its base, plus what you have staged (three-dot diff against the index)'
        : 'Everything this branch adds on top of its base, plus your uncommitted work (three-dot diff against the working tree)';
    case 'commit':
      return 'What this commit changed, against its parent';
    case 'journal':
      return 'The working tree compared against HEAD';
  }
}
