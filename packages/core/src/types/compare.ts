/**
 * Which uncommitted work a compare folds in, and which of it a compare row
 * holds.
 *
 * Its own module, apart from git/diff, because the web UI needs these
 * values at runtime and git/diff is Node-only: a browser import of it pulls
 * child_process, fs and simple-git into the bundle.
 */

/**
 * Which uncommitted work a compare row holds. Absent on a row that holds
 * only committed work.
 *
 * A compare that folds uncommitted work in is still ONE diff per file:
 * from the merge-base to the index, or to the working tree. So a file the
 * branch's commits touched that also has uncommitted edits is one row,
 * and this tag says which edits are in it: `staged`, `unstaged`, `both`,
 * or `untracked` for a file git does not track yet.
 */
export type UncommittedSide = 'staged' | 'unstaged' | 'both' | 'untracked';

/**
 * The three categories of uncommitted work a compare can fold in. All
 * false is the plain branch-vs-base compare.
 *
 * `unstaged` needs `staged`. Unstaged edits sit on top of staged ones in
 * the working tree, so "the branch plus unstaged edits but not staged
 * ones" is no tree that exists anywhere. The daemon refuses it.
 */
export interface UncommittedParts {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export const NO_UNCOMMITTED: UncommittedParts = {
  staged: false,
  unstaged: false,
  untracked: false,
};

export const ALL_UNCOMMITTED: UncommittedParts = {
  staged: true,
  unstaged: true,
  untracked: true,
};
