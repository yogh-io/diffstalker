/**
 * Which uncommitted work a compare folds in, and which side a compare row
 * came from.
 *
 * Its own module, apart from git/diff, because the web UI needs these
 * values at runtime and git/diff is Node-only: a browser import of it pulls
 * child_process, fs and simple-git into the bundle.
 */

/**
 * Which side of the working tree a compare row came from.
 *
 * `both` is the staged+unstaged pair read as ONE `git diff HEAD` rather
 * than as two diffs: a file changed on both sides produces one row, not
 * two chunks for the same path of which only the first survives.
 */
export type UncommittedSide = 'staged' | 'unstaged' | 'both' | 'untracked';

/**
 * The three categories of uncommitted work a compare can fold in, each
 * asked for independently. All false is the plain branch-vs-base compare.
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
