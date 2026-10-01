# Stacked pull requests in Compare

Decision document, written 2026-10-01. Amends `docs/feature-review-0.9.0.md`
§4 ("widening Compare's base picker beyond remote branches" stays rejected; a
stack picker is not that, see §4 here).

## 1. The trigger

The author stacks pull requests with `gh stack` (github/gh-stack). A stack is
a chain: the bottom PR targets `main`, and each PR above targets the branch of
the PR below it. Compare today always shows `merge-base(base, HEAD)...HEAD`, so
from the top of a stack it shows every layer at once, and no single PR's diff
can be seen without checking out that branch and picking its parent as base.

The request: pick a PR in the stack from the Compare view, and have that set
**both** the head and the base, so the diff becomes exactly that PR's diff.

This is the §6 "the author asks" trigger.

## 2. Where the stack comes from

Three sources were looked at.

1. **gh-stack's own file.** `gh stack init`/`add` write
   `<git-dir>/gh-stack` (JSON, `schemaVersion: 1`, one per worktree) with the
   trunk, every branch, its base and its PR number. Exact and local.
   **Not used**, because the author's real stack does not have one: GitHub
   stacks do not support forks, so the AERIUS stack was made from pushed
   `feature/*` branches with `gh stack link 8953 8954 8955`, which links PRs
   on GitHub "without local tracking" and writes no file. A design that reads
   the file misses the one stack that actually exists. gh-stack is also at
   v0.1.x, so its format is not a stable thing to build on.
2. **GitHub (`gh pr list`, the stack API).** Exact, has PR numbers. **Not
   used**: network, auth and GitHub-only, inside a daemon a browser can
   reach. That is a boundary the project does not cross.
3. **Git topology. Used.** A stack is a line of branch tips between trunk and
   HEAD. That is true however the stack was made (`init`, `link`, or by hand
   with `rebase --update-refs`), and needs only refs the repo already has.
   Checked against the real stack in `~/gitRepos/calculator`: from
   `upstream/main`, the first-parent path to `feature/aer-4693-nginx-image`
   carries exactly the three PR branches (local and `upstream/` copies at the
   same tips), and nothing else.

What topology cannot give: PR numbers. The strip shows branch names only.

## 3. Detection rules

`getStack(repoPath, trunk)` in `packages/core/src/git/stack.ts`:

1. `mb = merge-base(trunk, HEAD)`. None → no stack (empty result, not an
   error; Compare itself already answers 422 for that case).
2. Candidate refs: `git for-each-ref --no-merged=<trunk>` over `refs/heads`
   and `refs/remotes`, minus symbolic `*/HEAD` refs. A ref already contained
   in trunk is never a layer.
3. **At or below HEAD:** candidates whose tip is on
   `git rev-list --first-parent mb..HEAD`. First-parent only: a branch
   merged into a layer with a merge commit is reachable from it but is not
   a layer. The walk is capped (`STACK_WALK_LIMIT`, 1000 commits); a branch
   further than that from trunk is not a stack anyone reviews layer by
   layer, and the cap keeps the read bounded on a long-lived branch. Past
   the cap the oldest commits are not seen: a layer deeper than 1000
   first-parent commits from the merge-base is missing, and the lowest
   layer that is seen counts its commits from the cut, not from the
   merge-base.
4. **Above HEAD:** candidates that contain HEAD (`for-each-ref --contains HEAD`)
   and are not at HEAD's tip. Of their tips, `merge-base --independent`
   names the ones no other reaches. More than one is a fork above HEAD:
   those layers are left out and the result says `forkedAbove: true`. One
   line is shown or none; a tree is never flattened into a guess. With one
   top, the layers are the tips on `rev-list --first-parent HEAD..top`
   (same cap); a tip the top reaches but that sits off that line (a side
   branch merged into a layer) is not a layer, exactly as below HEAD.
5. Group refs by tip commit: one **layer** per tip. Its `name` is the local
   branch if there is one (the checked-out branch when several sit at
   HEAD's tip), else the remote-tracking name; a flag-shaped name (`-x`)
   is never picked while another is there, because the name travels as
   `?head=`. `refs` lists every name at that tip (local first, then remote,
   each sorted). A remote-tracking ref `<remote>/<name>` is dropped from
   the candidates when a local branch `<name>` is a candidate too: between
   a commit and a push the copy is behind, and would otherwise be a layer
   of its own (half a PR). The local branch is the user's truth; a copy at
   the same tip still lists in `refs`.
6. HEAD's tip is always a layer, `isHead: true`, even with no ref at it
   (detached, or commits past the last branch). Its name is then the current
   branch name, or `HEAD` when detached.
7. Layers are ordered bottom to top. Each carries `commits`: the count from
   the layer below (or from `mb` for the bottom one).

A single layer is not a stack. The client shows the strip only for two or more.

**Squash merges.** After the bottom PR is squash-merged, its branch is no
longer an ancestor of trunk, so it stays a layer until the stack is rebased
(or its branch deleted and pruned). That is what the git history says; it is
left as is.

## 4. Head and base

Compare gains one parameter, `head`. Today the head is always HEAD.

- `GET /repos/:id/compare`, `/compare/count` and `/compare/file` accept
  `?head=<ref>`, checked exactly as `?base=` is (ref shape, then
  `commitExists`, 400 when it does not resolve). Absent means HEAD, so every
  existing request is unchanged byte for byte.
- The range is `merge-base(base, head)...head`, and the commit list is
  `mb..head`. Inside a linear stack with base = the layer below, the
  merge-base is that layer's tip, so this is exactly the PR's diff.
- **Uncommitted work only exists against HEAD.** `head` together with any of
  `staged`/`unstaged`/`untracked` (or `/compare/file?uncommitted=`) is a 400.
  The client never sends that: picking the checked-out layer sends no `head`.
- `DiffRange`'s `compare` kind gains `head?: string`. Still a named range,
  never a raw revspec.

Why `head` takes any ref and not only a stack member: `base` already takes any
ref on the same routes, and a second, narrower rule for the other side of the
same range would be inconsistent for no gain. What stays rejected is a
free-text ref box in the UI. The strip is a closed list built from the stack,
the same way the base picker is a closed list of remote branches.

New read: `GET /repos/:id/compare/stack?base=<trunk>` (both API modes, it is a
read). `base` resolves exactly as on `/compare` (absent = the effective base).
Response:

```ts
// packages/core/src/types/stack.ts
interface StackLayer {
  name: string;        // what the strip shows and what ?head= carries
  refs: string[];      // every ref at this tip, local first
  tip: string;         // full hash
  commits: number;     // commits on top of the layer below (or trunk)
  isHead: boolean;
}
interface CompareStack {
  trunk: string;       // the resolved base, as /compare reports baseBranch
  layers: StackLayer[];// bottom to top; empty when there is no merge-base
  forkedAbove: boolean;
}
```

## 5. The web

- **State.** The base picker stays the **trunk** picker: what the stack hangs
  off. A new per-client `selectedStackHead: string | null` in the repo store
  names the picked layer. `null` is today's view (trunk...HEAD, the whole
  stack up to HEAD), and stays the default: opening Compare looks exactly as
  it does now.
- **Picking a layer** sets the request to `base` = the layer below (or trunk
  for the bottom one) and `head` = the layer's name, except for the `isHead`
  layer, which sends no `head` (so uncommitted toggles still work there).
  Changing the trunk in the base picker clears the layer.
- **The strip.** In the Compare top bar, under the base picker, only when the
  stack has two or more layers:
  `all · upstream/main ← jsp-to-html ← nginx ← [nginx-image] ← no-tomcat ●`.
  `all` is the null state. Each layer is a button with its commit count; the
  checked-out one has a marker. Trunk is a label, not a button. When
  `forkedAbove`, a short note says the stack forks above HEAD.
- **Uncommitted toggles** are hidden while a non-HEAD layer is picked.
- **The ref-pair label** (`utils/refPair.ts`) gains the head:
  `jsp-to-html…nginx`, and `base…HEAD` when there is none.
- **URL.** `?head=<name>` joins `base` in the URL grammar
  (`core/view/urlGrammar.ts`), Compare only. On load the store pulls the
  stack, and if the named layer is not in it, Compare shows
  `<name> is not a layer of this stack` in its error line and `all` stays
  available. No silent fallback to `all`.
- **Refresh.** The stack is re-pulled whenever Compare is re-pulled
  (`state-change` already fires on ref and HEAD moves). A picked layer whose
  name disappears (branch deleted) shows the same error line.

## 6. Not built

- PR numbers or titles (needs the network, §2).
- A forked stack as a tree.
- The CLI. It is demoted; its Compare keeps HEAD as head.
- Merging, rebasing or pushing a stack. Mutations from the browser stay out.

## 7. Files, by package

- core: `types/stack.ts` (the wire shape), `git/stack.ts` (+ test), `git/diff.ts` (`head` through
  `compareCommitted`, `getCompareDiff`, `getCommitCountBetweenRefs`,
  `DiffRange`), `view/urlGrammar.ts` (+ test).
- daemon: `routes/historyCompare.ts` (+ tests), `README.md` endpoint table.
- web: `api/client.ts`, `stores/repo.ts`, `views/CompareView.vue`, a
  `components/StackStrip.vue`, `utils/refPair.ts`, `composables/useUrlSync.ts`
  (+ tests).
- docs: `FEATURES.md`, `CHANGELOG.md`, `feature-review-0.9.0.md`.
