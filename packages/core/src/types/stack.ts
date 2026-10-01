/**
 * A stack of branches between a compare trunk and HEAD, as git topology
 * shows it — see docs/stacked-compare.md. Its own module so the web UI can
 * import the shape without touching git/stack, which is Node-only.
 */

/** One tip on the line from trunk to HEAD (or above it). */
export interface StackLayer {
  /** What the strip shows and what `?head=` carries: the local branch if
   *  there is one at this tip, else the remote-tracking name. */
  name: string;
  /** Every ref at this tip, local branches first, then remote-tracking. */
  refs: string[];
  /** Full commit hash of the tip. */
  tip: string;
  /** Commits on top of the layer below, or on top of the merge-base. */
  commits: number;
  /** True for the layer at HEAD's tip — the one with uncommitted work. */
  isHead: boolean;
}

export interface CompareStack {
  /** The resolved trunk, spelled as /compare reports `baseBranch`. */
  trunk: string;
  /** Bottom to top. Empty when trunk and HEAD share no history. */
  layers: StackLayer[];
  /** True when branches above HEAD fork, and so were left out. */
  forkedAbove: boolean;
}
