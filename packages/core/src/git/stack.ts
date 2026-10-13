/**
 * The stack of branches between a compare trunk and HEAD, read from git
 * topology alone — see docs/stacked-compare.md §3 for the rules and why
 * neither gh-stack's file nor GitHub is consulted.
 *
 * Every read here propagates its failure: a stack that quietly came back
 * empty would look exactly like "no stack", and the client would show the
 * plain compare without a word about why.
 */

import { createGit } from './gitClient.js';
import type { CompareStack, StackLayer } from '../types/stack.js';
import type { SimpleGit } from 'simple-git';

/**
 * How far a first-parent walk goes before it stops. A branch further than
 * this from trunk is not a stack anyone reviews layer by layer, and the
 * cap keeps the read bounded on a long-lived branch. Past it the oldest
 * commits are not seen: a layer deeper than this is missing, and the
 * lowest layer that is seen counts its commits from the cut, not from
 * the merge-base.
 */
export const STACK_WALK_LIMIT = 1000;

const LOCAL_REF_PREFIX = 'refs/heads/';
const REMOTE_REF_PREFIX = 'refs/remotes/';

/** One ref that is not merged into trunk: its tip and its short name. */
interface CandidateRef {
  tip: string;
  /** `feature/x` for a local branch, `origin/feature/x` for a remote one. */
  name: string;
  local: boolean;
}

/**
 * The refs under refs/heads and refs/remotes that trunk does not contain.
 * `--contains` narrows that to the refs reaching a commit. Symbolic refs
 * (`origin/HEAD`) are the remote's default pointer, not a branch of their
 * own, and are dropped by their `%(symref)` target being non-empty.
 */
async function listCandidates(
  git: SimpleGit,
  trunk: string,
  contains?: string
): Promise<CandidateRef[]> {
  const args = [
    'for-each-ref',
    '--format=%(objectname) %(refname) %(symref)',
    `--no-merged=${trunk}`,
  ];
  if (contains !== undefined) args.push(`--contains=${contains}`);
  args.push('refs/heads', 'refs/remotes');
  const out = await git.raw(args);

  const refs: CandidateRef[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [tip, refname, symref] = line.split(' ');
    if (symref) continue;
    if (refname.startsWith(LOCAL_REF_PREFIX)) {
      refs.push({ tip, name: refname.slice(LOCAL_REF_PREFIX.length), local: true });
    } else if (refname.startsWith(REMOTE_REF_PREFIX)) {
      refs.push({ tip, name: refname.slice(REMOTE_REF_PREFIX.length), local: false });
    }
  }
  return refs;
}

/**
 * The local branches among the candidates, name to tip — what decides
 * which remote-tracking copies to keep.
 */
function localTips(candidates: CandidateRef[]): Map<string, string> {
  return new Map(candidates.filter((r) => r.local).map((r) => [r.name, r.tip]));
}

/**
 * Drops a remote-tracking ref `<remote>/<name>` when a local branch
 * `<name>` is a candidate at another tip. Between a commit and a push the
 * local branch is ahead of its copy, and the copy would otherwise be a
 * layer of its own — half a PR, one the user never made. The local branch
 * is the user's truth. A copy at the same tip is kept: it lands in that
 * layer's `refs`. The remote is the first path segment, as it is for every
 * remote anyone names.
 */
function withoutRemoteCopies(refs: CandidateRef[], locals: Map<string, string>): CandidateRef[] {
  return refs.filter((r) => {
    if (r.local) return true;
    const localTip = locals.get(r.name.slice(r.name.indexOf('/') + 1));
    return localTip === undefined || localTip === r.tip;
  });
}

/**
 * The short names that have a remote-tracking copy on some remote:
 * `upstream/feature/x` names `feature/x`. A local branch with a copy is
 * one that was pushed, which is what a PR's branch is; a backup or a
 * scratch branch never was. The remote is the first path segment, as in
 * withoutRemoteCopies. Not `%(upstream)`: a branch made from
 * `upstream/main` tracks main, which says nothing about being pushed.
 */
function pushedNames(candidates: CandidateRef[]): Set<string> {
  return new Set(candidates.filter((r) => !r.local).map((r) => r.name.slice(r.name.indexOf('/') + 1)));
}

/** A remote-tracking ref, or a local branch with a remote-tracking copy. */
function isPushed(ref: CandidateRef, pushed: Set<string>): boolean {
  return !ref.local || pushed.has(ref.name);
}

/**
 * The first-parent line from `from` (excluded) up to `to`, oldest first,
 * so a commit's index plus one is its distance from `from`. Capped at
 * STACK_WALK_LIMIT: past the cap the oldest commits are missing.
 */
async function firstParentLine(git: SimpleGit, from: string, to: string): Promise<string[]> {
  const out = await git.raw([
    'rev-list',
    '--first-parent',
    `--max-count=${STACK_WALK_LIMIT}`,
    '--end-of-options',
    `${from}..${to}`,
  ]);
  return out.split('\n').filter(Boolean).reverse();
}

/** HEAD, as the layer builder needs it: its tip, and its name when no ref is there. */
interface Head {
  tip: string;
  /** The checked-out branch, or `HEAD` when detached. */
  name: string;
  branch: string | null;
}

/**
 * HEAD's tip and the branch it is on, from ONE git call. Read apart, a
 * checkout between the two reads would pair one HEAD's tip with another's
 * name; every later read takes the tip from here, never the literal HEAD.
 * Detached, the symbolic name git prints is `HEAD` itself.
 */
async function readHead(git: SimpleGit): Promise<Head> {
  const out = await git.raw(['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']);
  const [tip, symbolic] = out.split('\n');
  const branch = symbolic.startsWith(LOCAL_REF_PREFIX) ? symbolic.slice(LOCAL_REF_PREFIX.length) : null;
  return { tip, name: branch ?? 'HEAD', branch };
}

/**
 * Of several commits, the ones no other commit in the set reaches — one
 * commit when the set is a chain, more when it forks.
 */
async function independentTips(git: SimpleGit, tips: string[]): Promise<string[]> {
  if (tips.length < 2) return tips;
  const out = await git.raw(['merge-base', '--independent', '--end-of-options', ...tips]);
  return out.split('\n').filter(Boolean);
}

/**
 * The refs at a tip as the layer's name and ref list: local branches
 * first, then remote-tracking, each sorted. `preferred` (the checked-out
 * branch) wins the name when it is one of them, so the HEAD layer is
 * called what the user checked out and not whichever local branch at the
 * same commit sorts first. Otherwise a pushed local branch wins, then a
 * remote-tracking name, then any other local branch: a scratch branch at
 * a PR's tip is not the PR. A flag-shaped name (`-x`) is never picked
 * over another: the name travels as `?head=`, which refuses a leading dash.
 */
function nameLayer(
  refs: CandidateRef[],
  preferred: string | null,
  pushed: Set<string>
): { name: string; refs: string[] } | null {
  if (refs.length === 0) return null;
  const local = refs.filter((r) => r.local).map((r) => r.name).sort();
  const remote = refs.filter((r) => !r.local).map((r) => r.name).sort();
  const names = [...local, ...remote];
  const byPreference = [
    ...local.filter((n) => pushed.has(n)),
    ...remote,
    ...local.filter((n) => !pushed.has(n)),
  ];
  const name =
    preferred !== null && local.includes(preferred)
      ? preferred
      : (byPreference.find((n) => !n.startsWith('-')) ?? byPreference[0]);
  return { name, refs: names };
}

/**
 * The layers on one first-parent line: every tip on `line` that has a
 * candidate ref, in line order, each counting the commits since the layer
 * below (or since the start of the line). HEAD's tip is a layer even with
 * no ref at it (rule 7); `head` is null for the line above HEAD.
 */
function layersOnLine(
  line: string[],
  refsByTip: Map<string, CandidateRef[]>,
  head: Head | null,
  pushed: Set<string>
): StackLayer[] {
  const layers: StackLayer[] = [];
  let below = -1;
  for (let i = 0; i < line.length; i++) {
    const tip = line[i];
    const isHead = tip === head?.tip;
    const named =
      nameLayer(refsByTip.get(tip) ?? [], head?.branch ?? null, pushed) ??
      (isHead ? { name: head.name, refs: [] } : null);
    if (named === null) continue;
    layers.push({ ...named, tip, commits: i - below, isHead });
    below = i;
  }
  return layers;
}

/**
 * The layers above HEAD: the refs that contain HEAD, on the first-parent
 * line from the topmost of them. Two tips neither of which reaches the
 * other are a fork: no layers, `forked: true` — one line is shown or
 * none, never a tree flattened into a guess. Unpushed branches do not
 * make a fork on their own: when all the tips fork but the pushed ones
 * form one line, that line is the stack (an older copy of a layer, kept
 * as a backup, sits beside it). A tip the top does reach but
 * that sits off its first-parent line (a side branch merged into a layer)
 * is simply not a layer, exactly as below HEAD.
 */
async function layersAbove(
  git: SimpleGit,
  trunk: string,
  headTip: string,
  locals: Map<string, string>,
  refsByTip: Map<string, CandidateRef[]>,
  pushed: Set<string>
): Promise<{ layers: StackLayer[]; forked: boolean }> {
  const above = withoutRemoteCopies(await listCandidates(git, trunk, headTip), locals).filter(
    (r) => r.tip !== headTip
  );
  const tips = [...new Set(above.map((r) => r.tip))];
  if (tips.length === 0) return { layers: [], forked: false };

  let tops = await independentTips(git, tips);
  if (tops.length > 1) {
    const pushedTips = [...new Set(above.filter((r) => isPushed(r, pushed)).map((r) => r.tip))];
    if (pushedTips.length > 0) tops = await independentTips(git, pushedTips);
  }
  if (tops.length !== 1) return { layers: [], forked: true };

  const line = await firstParentLine(git, headTip, tops[0]);
  return { layers: layersOnLine(line, refsByTip, null, pushed), forked: false };
}

/**
 * Drops the layers that only unpushed branches name and that sit below a
 * pushed layer, bottom to top in, bottom to top out. Such a branch points
 * inside a PR (a backup of an older tip, a scratch copy) and would split
 * it in two. Its commits go to the layer above. An unpushed tip above
 * every pushed one stays a layer: that is a new layer not pushed yet, and
 * a stack nobody pushed keeps every branch. The HEAD layer always stays.
 */
function withoutUnpushedInside(layers: StackLayer[], pushedTips: Set<string>): StackLayer[] {
  const kept: StackLayer[] = [];
  let pushedAbove = false;
  for (const layer of [...layers].reverse()) {
    const isPushedTip = pushedTips.has(layer.tip);
    if (pushedAbove && !isPushedTip && !layer.isHead) {
      kept[kept.length - 1].commits += layer.commits;
      continue;
    }
    kept.push({ ...layer });
    if (isPushedTip) pushedAbove = true;
  }
  return kept.reverse();
}

/**
 * The stack from `trunk` to HEAD and above it, bottom to top. Empty
 * layers when trunk and HEAD share no history. The HEAD layer is always
 * present, named after the checked-out branch (or `HEAD` when detached)
 * when no ref sits at its tip.
 */
export async function getStack(repoPath: string, trunk: string): Promise<CompareStack> {
  const git = createGit(repoPath);
  const head = await readHead(git);

  // Same probe as compareCommitted: with no common ancestor git exits 1
  // with empty output, which simple-git resolves to ''.
  const mergeBase = (await git.raw(['merge-base', '--end-of-options', trunk, head.tip])).trim();
  if (!mergeBase) return { trunk, layers: [], forkedAbove: false };

  const [allCandidates, line] = await Promise.all([
    listCandidates(git, trunk),
    firstParentLine(git, mergeBase, head.tip),
  ]);
  const locals = localTips(allCandidates);
  const pushed = pushedNames(allCandidates);
  const refsByTip = new Map<string, CandidateRef[]>();
  const pushedTips = new Set<string>();
  for (const ref of withoutRemoteCopies(allCandidates, locals)) {
    const at = refsByTip.get(ref.tip);
    if (at) at.push(ref);
    else refsByTip.set(ref.tip, [ref]);
    if (isPushed(ref, pushed)) pushedTips.add(ref.tip);
  }

  const below = layersOnLine(line, refsByTip, head, pushed);
  // HEAD at the merge-base (checked out at trunk, or merged into it): the
  // line is empty, and the HEAD layer has no commits of its own.
  if (!below.some((l) => l.isHead)) {
    below.push({ name: head.name, refs: [], tip: head.tip, commits: 0, isHead: true });
  }

  const above = await layersAbove(git, trunk, head.tip, locals, refsByTip, pushed);
  return {
    trunk,
    layers: withoutUnpushedInside([...below, ...above.layers], pushedTips),
    forkedAbove: above.forked,
  };
}
