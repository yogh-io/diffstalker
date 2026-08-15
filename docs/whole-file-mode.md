# Whole-file mode in the diff view

Decision document, written 2026-08-15. Amends `docs/feature-review-0.9.0.md` §4
and §6, and the URL grammar's stated principle in
`packages/core/src/view/urlGrammar.ts`.

Status per slice (§10):

- **Slice 0 — done.** Context pinned to `-U3` on every diff function
  (`DIFF_CONTEXT_LINES` in `packages/core/src/git/diff.ts`), with tests that
  fail without it. A defect fix; it needed no trigger and shipped on its own.
- **Slice B — done.** Whole-file mode in Changes, the `whole` parameter, the
  store slot, the URL key and its principle rewrite, and the Explorer's
  `show changes` button.
- **Slice A (the always-on ref-pair label) — not built.** It was specified to
  ship first and did not; the mode was asked for directly. It stands on its own
  and is still worth doing.
- **Slices C–D — proposed.** Not built.

**Where the build deviated from this document, and why.** Both are corrections
to it, not shortcuts around it:

1. **§8.2 said `pendingAnchor` needs no widening.** It does. A cold load parks
   the anchor before any status has arrived, and replaying it without the flag
   drops `whole=1` on the floor — the next truthful write then rewrites the URL
   without it, so F5 on a whole-file link silently gives you hunks. That is the
   one requirement the author stated as hard. `pendingAnchor` carries `whole`.
2. **§6.5 said to re-express `HUGE_FILE_CHANGED_LINES` against `rowCount`.**
   Not done, deliberately. That gate decides whether a body renders at all, and
   rowCount-gating it would collapse the whole-file body the reader just asked
   for behind "Load diff". The stats it reads do not move with context, so a
   whole-file body cannot trip it, and `renderedSmallKeys` already latches a
   file being read. The payload is bounded by the daemon's per-file cap, which
   is where that job belongs. `estimateBodyHeight` DID need the rowCount path
   and got it — the stats guess under-sizes a whole-file body about twentyfold,
   and the stack's arithmetic offsets are built on that number.

The analysis is kept as written, the way `docs/search-design.md` keeps its own.
§9 is the override section: which §6 trigger fired, on what evidence, the one
rejection it lifts, and the longer list it explicitly does not.

---

## 1. Verdict

Build it, in the diff view, as a mode over the pair that view already pins.

Three things, in order:

1. **Print the ref pair** on every diff file header (Changes, Compare, History, Journal). No wire change, no URL change, useful on its own.
2. **A per-file `whole file` toggle in Changes.** It swaps that one file's diff for a `-U100000` pull of the same pair and renders it in the same `DiffView`. It is carried in the URL as `whole=1`, so F5 restores it.
3. **A `show changes` button in the Explorer's file header** — the mirror of `view file`. It navigates. It renders nothing.

Compare and History get the same toggle in a later slice, because a path-scoped diff there destroys rename detection and Changes is already path-scoped today.

Nothing renders a diff inside the Explorer. No ref is ever typed or picked anywhere. The wire carries a boolean, not a number, so the context slider `feature-review-0.9.0.md` §4 rejected cannot be expressed even by hand-editing a URL.

The author's first lean is right in substance and wrong in one detail (§8). The author's second lean forces an amendment to the URL grammar's governing sentence; the amendment is correct — the sentence is too broad, not wrong.

---

## 2. The design

### 2.1 The ref-pair label

`RefPairLabel.vue`, presentational, one discriminated-union prop. Dropped into the three existing per-file header sites: `DiffStack.vue:1299` (Changes, Compare), `DiffView.vue:265` (History sections), `JournalView.vue:705` (entry header).

```
M  packages/web/src/stores/repo.ts   index → working tree   whole file   view file   copy path   +12 −4
```

Hard constraint, and it is the one way this breaks the app: `chromeHeaderH()` (`DiffStack.vue:629-640`) measures the **first** `.file-diff-header` it finds, memoizes that single number, and hands it to `sectionOuterHeight` for **every** section. So:

- the label is an inline `<span>` inside the existing header line box, at the header's own font size, with **zero block padding and a `1px solid transparent` border** — the same contract `ViewFileButton.vue:47-56` and `CopyPathButton.vue:62-66` both state in their CSS;
- **no new header line, ever.** Not for the pair, not for a "too large" notice, not for anything. Every variant of the label must render at identical height.

### 2.2 The `whole file` toggle

`WholeFileToggle.vue`, props `{ on, busy, disabled }`, emits `toggle`. Same header line, same zero-block-padding contract. Label `whole file`; when on, `hunks`. `data-testid="whole-file"`.

- **Rendered in:** Changes (slice B). Compare and History in slice C. **Not** Journal — a journal entry *is* a hunk slice; "whole file" on it is a category error, and Journal is the one surface where per-hunk edit stamps are the content.
- **Hidden when:** the file is untracked (already whole by construction), binary, an image, or the section is a large-file strip.
- **Default:** off. Not persisted anywhere.
- **Scope: exactly one file at a time — the anchored one.** Turning it on for file B turns it off for file A. This is not a limitation dressed as a rule; it is what makes the mode URL-addressable without putting an expansion set in the address bar, and it reduces the store change from a variant dimension on the `workingDiffs` cache to a single extra slot (§6.3).
- **No keybinding.** `view file` and `copy path` have none either. Claiming a letter needs its own justification; this does not earn one.

Clicking it: `beginUserNav({ view: 'changes' })`, set the store's whole-file key, fetch, swap. Clicking again, selecting another file, switching view, or switching repo turns it off.

When on, the section renders every line of the file, numbered on both sides, in the same 4-column grid. The sticky `@@` header is suppressed — one hunk spanning lines 1..N says nothing.

### 2.3 `show changes` in the Explorer

`ShowChangesButton.vue`, modelled line-for-line on `ViewFileButton.vue`: one `path` prop, reads the stores directly, same CSS contract. Lives in `FileContentPane.vue`'s header meta cluster, next to `<WrapToggle />`.

Rendered **only** when the path is in `repo.shared.status` — no probe request, no daemon roundtrip, no dead button on an unchanged file. On click:

```ts
beginUserNav({ view: 'changes' });
ui.setActiveView('changes');
ui.setActiveStackKey(key);        // workingDiffKey: 'u:'+path, or 's:'+path when only staged
ui.requestStackScroll(key);       // the existing seq-stamped channel
```

Partially staged file (two rows): pick the unstaged one. It is the row whose new side is the bytes the Explorer was just showing.

`ui.requestStackScroll` is set before `ChangesView` mounts, so its watcher needs `immediate: true` plus the existing seq guard — the same shape `App.vue`'s restore path already uses.

---

## 3. The ref answer

The user never picks a pair. Every surface already fixes one; the app has simply never said which. So: **inherit the pair, print the pair, never offer a revspec.**

| Entry point | Ref pair in force | How the user knows | When it does not resolve |
|---|---|---|---|
| Changes, unstaged row (`u:`) | `index → working tree` | header label | — |
| Changes, staged row (`s:`) | `HEAD → index` | header label | — |
| Changes, untracked | `new file → working tree` | label reads `new file` | Over `MAX_UNTRACKED_DIFF_BYTES` (256 KiB) the file is never read; existing notice. Toggle hidden — already whole |
| Changes, deleted | `index → (deleted)` | label | Whole-file diff is the whole file as deletions. Works |
| Compare, committed row (`c:`) | `<base>…HEAD` (three-dot, merge-base) | label, plus the existing head→base toolbar line | No usable base → daemon 422, Compare's existing empty state. Label absent |
| Compare, uncommitted row (`u:`) | `HEAD → working tree` | label | This is a **different base** from the committed rows in the same stack. Today that is signalled only by an `[uncommitted]` tag that never mentions the base. The label is the fix |
| History, file in a commit | `<shortHash>^ → <shortHash>` | label | Merge commit: `git show --format=` returns an empty diff (`historyCompare.ts:113-118`). Label reads `merge commit` and the toggle is hidden. This does not fix the known-wrong combined-diff defect; it stops lying about it |
| Journal entry | `HEAD → working tree` | label | — |
| Explorer | **none.** Worktree bytes, `fs.stat` + `fs.open`, no pair exists | header names no pair; `show changes` is the only ref-bearing affordance and its target is fixed | File not in status → button not rendered |

Two non-resolutions that decide the shape of the whole feature:

**An unchanged file has no whole-file diff.** Verified: `git diff -U100000 -- <clean file>` emits **0 bytes**. Whole-file mode is structurally not a file reader. It can only ever show a file that already appears in a diff surface. This is the load-bearing reason the Explorer keeps its own renderer and its own endpoint (§4).

**A renamed file, path-scoped, renders as an add.** Verified in a scratch repo:

```
git diff --cached --name-status -M              →  R100  old.txt  new.txt
git diff --cached --name-status -M -- new.txt   →  A     new.txt
```

Changes already fetches per file with a pathspec (`routes/workingTree.ts:71`, `getDiff(path, file, staged)` → `git diff [--cached] -- <file>`), so this is today's behaviour there and whole-file mode does not make it worse. Compare and History do **not** — they pull whole and split client-side. That is why they are a later slice (§6.6).

---

## 4. What is explicitly not built

**No diff data enters the Explorer.** `FileContentPane` keeps `GET /repos/:id/file` and keeps `readFileForDisplay`. It gains one navigation button that calls `setActiveView`. It gains no marker column, no diff endpoint, no ref parameter, no `DiffResult`.

The reason this cannot drift is not a rule in a module comment. It is a property of the data: a diff of an unchanged file is empty, and most files the Explorer shows are unchanged. A "changes overlay in the Explorer" would be blank for the majority of what the Explorer is for, so it would immediately need a *second* data path — content when clean, diff when dirty — and that second path is the thing constraint 1 forbids. The Explorer's subject is files at rest. The diff view's subject is files that changed. The split is the app's, not a fence around a feature.

Also not built, and re-confirmed as rejected:

- **No ref picker, anywhere.** No free-text revspec box, no `l`/`r` query keys, no ref vocabulary on the wire.
- **No widening of Compare's base picker.** `getCandidateBaseBranches` stays remote-only.
- **No context slider, no incremental expansion.** The wire carries `whole=true`, not `context=N`. The URL carries `whole=1`, not a number. Neither grammar can express "10 more lines". This is enforcement, not a promise.
- **No text-at-a-ref endpoint.** `openBlob` stays image-only. No third surface reading repo content the client does not hold — the whole-file diff is `/diff` reading what `/diff` already reads, with one flag changed.
- **No change marks in `FileContentPane`.** No annotation join.
- **No fifth view.** Adding `'file'` to `VIEW_NAMES` makes it a restorable default (`ui.ts:98-101` → `savePrefs({activeView})`, `prefs.ts:135`), so a cold tab would open into an empty file view. `search-design.md:752` re-confirmed "no sixth view" by name while lifting only two rejections.
- **No per-file log.**

---

## 5. The mode is not a whole-file *reader*

Worth stating on its own, because three of the four proposals blurred it: whole-file mode does not replace `view file`. It shows a changed file whole. It cannot show a clean file at all. If the author wants to read `MonitorMap.vue` when it has no changes, the Explorer is still the answer and always will be.

---

## 6. Mechanism and cost

### 6.1 Wire

`GET /repos/:id/diff?path=…&staged=…&whole=true`

- Parsed with the existing `parseBoolParam` (`routes/shared.ts:164-170`).
- **400 when `whole` is set without `path`.** `/diff` treats `path` as optional today — `getDiff(handle.path, undefined, staged)` is the whole-tree branch. On a `--port` daemon GETs are CSRF-exempt, repo ids are offline-computable from a guessed path, and nothing throttles `/diff`. `whole` without `path` would be an unbounded `git diff -U100000` over the entire tree. Requiring `path` closes it.
- **Skip `stampDiff` when `whole` is set** (`routes/workingTree.ts:78`). This is not optional — see §6.4.
- **Routing: zero changes.** `/diff` is registered in `registerWorkingTreeRoutes`, already on both the `full` and `web` routers. A new query parameter needs no routing-table decision.

### 6.2 Core

`getDiff(repoPath, file?, staged = false, opts?: { context?: number })` pushes `-U${context}` into `args` before `--`. `WHOLE_FILE_CONTEXT = 100000` as a named constant.

**Slice 0, shippable alone and needing no trigger:** the default becomes an explicit `-U3` on `getDiff`, `getCommitDiff`, `getDiffBetweenRefs` and `getCompareDiffWithUncommitted`. Today only `getDiffAgainstHead` pins it (`diff.ts:145`), and its own comment says why: *"a user's diff.context config would otherwise change hunk merge/split geometry between machines."* That condition is live on three other endpoints. This is a defect fix, not a no-op — for a user with `diff.context` set it re-keys hunks once (`hunkTimes.ts:29-59` hashes only the +/− body), which restamps `editedAt` and drops one set of scroll anchors. Say so in the changelog.

### 6.3 Store — one slot, not a cache variant

Changes' per-file bodies come from `workingDiffs`, a store-owned keyed cache with activation, per-key refresh on every applied wire state, eviction, `appliedSeqByKey` staleness tokens, identity preservation and a `WHOLE_TREE_REPULL_THRESHOLD` bulk path (`stores/repo.ts:900-1122`). Putting a whole-file body in the component would go stale the moment the file watcher fires — the U3 entry refreshes underneath and the whole-file body silently renders old text. That is a lying diff in the exact case the mode is most wanted.

Because **only one file is whole at a time**, the fix is one slot, not a variant dimension:

```ts
const wholeFile = shallowRef<{ key: string; diff: DiffResult } | null>(null);
```

Set/cleared by `setWholeFile(key | null)`. Refetched by `updateWorkingDiffsAfterState` when the key is in the changed set; cleared when the key leaves the status set, on repo switch, and on key change. `DiffStack` reads it through `stackFiles`, so the swap replaces the `files` array with a new `DiffResult` object — which `buildDiffModel`'s identity memoization and `prev.diff !== item.diff` (`DiffStack.vue:865`) treat as an ordinary content commit, flowing through the anchor sandwich correctly.

### 6.4 Hunk identity

`HunkTimeTracker.stamp()` **writes** into a shared per-repo map. A whole-file diff is one hunk per file, so its key is a hash of every changed line in the file — a key the manager's own U3 refresh never produces. Stamping it would pollute the tracker, resolve `editedAt` to the file's mtime ("just now"), and flash the whole file as fresh.

**Call: the whole-file diff is not stamped.** `/commits/:hash/diff` already made this exact decision (`historyCompare.ts:119-120`). Consequence, deliberate: whole-file mode has no edit times, no freshness flash, no per-hunk age. The U3 body stays in `workingDiffs`, so toggling back restores all of it.

Adjacent, needing no action: hunk badge counts come from the manager's own whole-tree U3 diff and are untouched; the web has no hunk-level mutations (`stageFile`/`unstageFile` only), so `extractHunkPatch`'s "one hunk = the whole file" hazard does not exist on this surface.

### 6.5 Height model and virtualization

- **Row virtualization: unaffected.** Context rows are the same fixed height as add/del rows, so `content-visibility: auto; contain-intrinsic-size: auto var(--row-h)` stays true. The Explorer already mounts up to 5000 rows on this mechanism. The ceiling this mode needs is the ceiling the app already demonstrates.
- **`exactBodyHeight`: still exact, and cheaper.** It is O(hunks) — one giant hunk is less work to size than fifty small ones.
- **`estimateBodyHeight` must gain a rowCount path.** It is stats-based (`insertions + deletions`) and under-sizes a whole-file body by ~20×. Use `diffModel(...).rowCount` when a model exists. Additionally, **gate the swap on `probeSizes !== null`** — the swap is user-initiated and async, so this is one condition, not a scheduling problem.
- **`HUGE_FILE_CHANGED_LINES = 1500` stops protecting**, because it reads `stats`, which context does not move. Two things close it: the daemon's 5000-line cap bounds the payload, and the gate is re-expressed against `rowCount` when a model exists — which also makes it correct for the U3 path it was written for.
- **Scroll anchoring degrades, unmitigated and named.** `anchorCandidates` anchors on file sections *and* on each `.hunk`. One hunk means the anchor can only pin the file top, so a watcher refresh inside the file being read can move what the reader is looking at. Confined to one file, in a mode turned on deliberately.
- **`--row-h` is published only by `DiffStack`'s probe** (`DiffStack.vue:463`, on `document.documentElement`). Slice B lives in `DiffStack`, so this is fine. Slice C's History surface is a standalone `DiffView` with no stack mounted — on a cold load direct to `/history` it gets the `1.26rem` CSS fallback, which is a pre-existing drift that whole-file amplifies by two orders of magnitude. Slice C must answer it; slice B does not.

### 6.6 Why Compare and History are a later slice

Both would need a `path` parameter on `/compare` and `/commits/:hash/diff`. A path-scoped diff loses rename detection (verified above), which would flip a rename-with-edits into a 100%-additions whole file — a *new* wrong answer from a feature whose point is fidelity. It would also make `/compare?path=` return a wrong `commits` list and `uncommittedCount`, which Compare's header reads.

The fix exists and is known: the daemon already resolves renames server-side for images (`routes/blob.ts:308-322` `sidesFor`), and the full `--name-status -M` pass already tells it the original path, so the pathspec can carry both paths. That is real machinery and it is not slice B.

### 6.7 Syntax highlighting

Slice B ships with the existing per-line highlighting, and this is a known cosmetic defect. `diffHighlight.ts`'s module comment states the reason: a hunk interleaves two file versions, so there is no single valid document to feed hljs. Over 30 hunk lines a mis-tokenized block comment is a blemish; over a whole `.vue` SFC the `<template>` block miscolours from its first line to the end. It also costs N hljs calls plus N `TOKEN_RE` re-parses instead of one document pass, memoized per row but paid across the whole file.

Whole-file mode is the one case where the excuse stops applying: with full context each **side** is a complete document. One `hljs.highlight` per side, split per line by the existing `splitHighlightedHtml`, converted by a new `runsFromHtmlLine(html)` — the `TOKEN_RE` walk already inside `highlightToRuns`, minus the hljs call — then `mergePieces` unchanged. ~60 lines, one new function, and it reduces the call count from N to 2. That is slice D and it is the highest-value follow-up in this document.

### 6.8 Size caps — real numbers

Per-file, all-or-nothing: `MAX_FILE_DIFF_LINES = 5000`, `MAX_FILE_DIFF_BYTES = 256 KiB` (`diffParse.ts:72-80`). Over either, `capChunk` keeps the headers and appends `Large file — diff not shown (…)`.

A whole-file diff costs ≈ **file bytes × 1.07**, plus one extra copy of each deleted line. Measured on this repo:

| File | lines / bytes | `-U3` | `-U100000` | vs caps |
|---|---|---|---|---|
| `packages/web/src/views/CompareView.vue` | 923 / 29,569 | 4,244 B / 92 lines | 31,548 B / 942 lines | 12% bytes, 19% lines |
| `README.md` | — | 1,280 B | 14,225 B | 5% / — |

So the **byte cap bites at ~245 KB of file text; the line cap at ~4,990 source lines.** No tracked file in this repo would trip either cap whole; the largest, `docs/search-design.md` (2,301 lines / 139 KB), reaches ~53% of the byte cap. The real victims are minified bundles, single-line SVGs and `package-lock.json` — the files the cap was written for, which get nothing everywhere else already.

**Call: do not raise the caps and do not add a second cap pair.** Over the cap the daemon withholds as it does today, the client detects it with the existing `isLargeFileDiff` / `LARGE_DIFF_NOTICE_PREFIX`, **the U3 body stays on screen**, and the toggle renders disabled reading `whole file — too large`. One branch, no new line in the header, no new constant.

The tempting invariant — *"if the Explorer shows the file's text, whole-file shows it"* — cannot be implemented and should not be claimed. The Explorer **truncates** at 5000 lines and still renders; `capChunk` **withholds**. And since the diff costs file × 1.07, a byte-parity cap still refuses every file just under the Explorer's 1 MiB limit. An invariant you cannot hold is worse than a stated limit.

### 6.9 Files, by package

**core** — `view/urlGrammar.ts` (+ header rewrite, §8.2), `view/urlGrammar.test.ts`, `git/diff.ts`, `git/diff.test.ts`.

**daemon** — `routes/workingTree.ts`, its route tests, `README.md`'s endpoint table.

**client** — `src/client.ts` (`diff()` gains `whole`).

**cli** — **none.** `UrlPlace.whole` is optional, so `packages/cli/src/commands/link.ts` compiles unchanged and simply never emits the key. (This matters: the URL grammar now lives in core and is shared with `diffstalker link`, which the briefing material predates. A *required* field there would have forced `link.ts`'s USAGE, its parse, and its prove-the-anchor-exists contract into scope.)

**web** — `api/client.ts`, `stores/repo.ts`, `composables/useUrlSync.ts`, `App.vue`, `components/DiffStack.vue`, `components/DiffView.vue`, `components/FileContentPane.vue`, `views/ChangesView.vue`, `views/CompareView.vue`, `views/HistoryView.vue`, `views/JournalView.vue`, plus three new components (`RefPairLabel.vue`, `WholeFileToggle.vue`, `ShowChangesButton.vue`).

**Tests** — `useUrlSync.test.ts` (whole-object `toEqual` parse assertions all change), `urlGrammar.test.ts`, `DiffStack.test.ts` (identity swap, rowCount estimate, probe guard, refusal falls back to hunks, header height constant across label variants), `ChangesView` tests, `repo.test.ts` (the whole-file slot: set, refetch on state-change, clear on key change and repo switch), daemon route tests (`whole` requires `path`; `whole` does not stamp), and three new component test files.

**Docs** — `docs/whole-file-mode.md` (this document, committed), the `feature-review-0.9.0.md` amendment, `FEATURES.md`, `CHANGELOG.md`, `packages/daemon/README.md`.

**Honest scale:** ~22 files. Two to three focused sessions across slices A and B, not one. The `-U` flag is the cheap part; the store slot, the height-model fixes and the URL grammar are the bill.

---

## 7. The hard calls

Where the four proposals genuinely disagreed, and which way it goes.

**Control in the Explorer pane vs the diff header.** → Diff header. Three reasons, in order of weight: the author said so; `git diff -U∞` on a clean file is empty, so a change overlay in the Explorer needs a second data path for the majority of files it shows, and that second path *is* the thing constraint 1 forbids; and a new fifth view was re-confirmed as rejected by name in the search override and breaks `setActiveView`'s persisted default.

**Annotation join vs whole-file diff.** The annotation angle's core observation — *change marks are invariant under `-U`, because a `-U3` diff already carries every added line's new-side number and every deleted line's text* — is true, elegant, and portable. It loses anyway: it needs a second render path inside `FileContentPane` (HTML-string highlighting vs decoded pieces), it puts the control in the Explorer, it still hits renames and the untracked whole-file cap, and it delivers "where you changed something" rather than "what it was." `DiffView` renders a whole file with change marks today, with zero renderer changes. Keep the observation on file; do not build on it.

**Per-file expansion set vs the anchored file only.** → Anchored file only. It is what makes the mode URL-addressable without putting an expansion set in the address bar (which the URL grammar bans on its own terms and should keep banning), and it collapses the store work from a variant dimension on `workingDiffs` to one slot.

**`?context=N` vs `?whole=true`.** → Boolean. A number reopens the incremental expansion and context-slider that §4 rejected. The protocol should not be able to say it.

**Raise the caps vs keep them.** → Keep them, and do not claim parity with the Explorer. §6.8.

**A path parameter on `/compare` and `/commits/:hash/diff`.** → No, verified against git. That is why Compare and History are slice C, not slice B. Changes is unaffected because it is already path-scoped.

**A ref pair in the URL (`l`/`r`).** → No. The pair is fully determined by `view` + `at` + `base`. Adding two keys for information the URL already implies is a second address space, and it is the only formulation in the four proposals that brushes the boundary-rejected free-text revspec box.

**Cross-over from the Explorer: keep or drop.** → Keep, Changes-only. Without it the control is three views away from where the need arises and the Explorer stays a sink. But the Compare half as proposed does not work: Compare's stack key is `c:`/`u:`-prefixed by `compareFileKey`, and `CompareView` computes its own `activeStackKey` from `repo.compare.selection` and ignores `ui.setActiveStackKey` entirely. Changes-only is correct and correctable later.

---

## 8. The author's leans

### 8.1 Lean 1 — "a mode of the diff view; the diff view should internally function on 2 refs"

**Confirmed as a mode. Corrected on the internal two-ref model.**

The mode half is right and cheap. Every diff surface already pins a pair, `DiffView` already renders a whole file with change marks (a `context` row already carries both line numbers), and `-U` is a one-line change in `getDiff`. Hunks-vs-whole-file is a clean mode over that pair, and — importantly — it is a mode with a *ceiling*: whole file is the maximum, so there is nothing between "3 lines" and "all of it" for the feature to grow into.

The internal-two-refs half needs correcting. **No endpoint in this daemon takes two arbitrary refs**, and the pair each view uses is implicit in *which endpoint was called*, not in a parameter: `/diff` carries only `staged`, `/compare` carries only `base`, `/commits/:hash/diff` carries only a hash. Threading a `RefPair` through core would therefore not be a refactor that makes an existing truth explicit — it would be a new abstraction at the wire, and one that has to answer for renames (`sidesFor` is the only thing in the repo that materializes a per-file pair, and it takes the status entry, not a path). The pair *is* fully knowable client-side from the surface. So:

> Adopt the two-ref model where it is free — as a **label** derived client-side, and as the mental model for the mode. Do not build it as a parameter.

**Does it solve the original problem, or relocate it?** As stated, it relocates it: the author was in the Explorer, and every deliberate cross-view jump in this app points *at* the Explorer. `ViewFileButton` from three headers, the finder, search, follow mode — there is no route out. The gap is closed by `show changes` (§2.3), which is the mirror of a button that already exists and renders no diff. That is a real close, not a fig leaf: the trip is two clicks with no page load, and the file the user lands on is the file they were reading.

What it does **not** close: the author reads the file in the Explorer with document-accurate highlighting, the outline popover, and `data-ln` scroll-to-line, and the diff view has none of those. Whole-file mode hands them change marks and takes three things away. That is the honest residual cost of putting the control where the author put it, and slice D (per-side document highlighting) recovers one of the three.

### 8.2 Lean 2 — "a URL should still always function; F5 gets the user to the exact same view"

**Confirmed as a hard requirement. The URL grammar's stated principle is too broad and must be rewritten.**

The current sentence bans "modes" outright, and `whole` is a mode by that sentence's own vocabulary. But the sentence does not describe what the code actually does — `base` is in the URL and is not a place either. The real line the code draws is **anchor scope plus ownership**, and once stated that way `whole` is admissible and `wrap` still is not.

**The corrected principle:**

> A key belongs in the URL when it is scoped to the anchor — or to what the anchor is resolved against — **and** is decided per visit rather than owned by the reader. `base` qualifies: it decides what `at` resolves against. `whole` qualifies: it decides how much of `at` is drawn. Preferences fail the second half and live in localStorage. View-wide switches fail the first half and stay in their stores.

**Exact rewrite, `useUrlSync.ts` lines 1-5.** Replace:

```
 * useUrlSync: the URL is the app's address bar in the literal sense — it
 * names ONE PLACE (a repo, a view, and the one anchor you are aimed at
 * inside it) and nothing else. Preferences, modes, expansion sets and
 * scroll offsets are not places and never appear.
```

with:

```
 * useUrlSync: the URL is the app's address bar in the literal sense — it
 * names ONE PLACE: a repo, a view, the one anchor you are aimed at inside
 * it, what that anchor is resolved against, and how much of it is shown.
 * Nothing else.
 *
 * THE TEST is anchor scope plus ownership. A key belongs here when it is
 * scoped to the anchor (or to what the anchor resolves against) AND is
 * decided per visit rather than owned by the reader.
 *   - `base` passes: it decides what `at` is resolved against, and it is
 *     an explicit per-visit pick (a detected base is never written back).
 *   - `whole` passes: it decides how much of `at` is drawn. One file at a
 *     time, by construction — that is what keeps it an anchor property and
 *     not an expansion set.
 *   - wrap, syntax, unified/split, image diff mode FAIL on ownership. They
 *     belong to the reader, not to a link, and live in localStorage.
 *   - the explorer's dotfiles/ignored/changed and compare's
 *     include-uncommitted FAIL on scope. They are view-wide switches, not
 *     properties of one anchor, and stay in their stores.
 *   - scroll offsets and expansion sets are neither, and never appear.
 * Do not cite `whole` as precedent for putting a preference here. It is in
 * the URL because it is per-anchor and per-visit; a preference is neither.
```

`urlGrammar.ts`'s own header grammar line becomes `/<view>/<repo-segments…>[?base=…][&whole=1][&at=…]`.

**Mechanical consequences, all mandatory.**

*In `packages/core/src/view/urlGrammar.ts`:*
- `UrlState` gains `whole: boolean`; `EMPTY_URL_STATE` gains `whole: false`.
- `parseUrl` reads `query.get('whole') === '1'` and adds it to **both** returns — the repo-less early return as well as the full one. Missing the early return silently drops the key for `/changes` with no repo segments.
- `UrlPlace` gains `whole?: boolean` (optional, so `link.ts` is untouched); `buildUrlPath` writes it at a **pinned position: `base`, `whole`, `at`.** Order is load-bearing — `writeUrl` compares `path + search` as a string, so a differently ordered URL never compares equal and is rewritten on the first write.
- Value is `whole=1`. Present means on, absent means off. Not `true`/`false` — absence is the off state, and there is no third state to encode.
- `urlGrammar.test.ts`'s whole-object assertions all change.

*In `packages/web/src/composables/useUrlSync.ts`:*
- `Place` gains the field.
- `derive()` gates it on `view === 'changes'` (slice B; widened with slice C) and reads `repo.wholeFile?.key === currentAnchor()`.
- **`anchorOnly()` must gain it.** This is the trap: `anchorOnly` defines "only the anchor moved" as repo + view + base all equal, and a change it cannot see is classed as anchor movement, deferred into the 400 ms `ANCHOR_THROTTLE_MS`, and flushed as `'replace'`. Left out, the toggle can **never** mint a Back entry and its URL update lags 400 ms. In: a `whole`-only change is `'replace'` by default and `'push'` under an open intent — which is what the toggle calling `beginUserNav({view:'changes'})` gives it. Back turns the mode off.
- **`titleFor()` must include it**, or two Back entries for the same file read identically in the menu.
- The `watch()` dependency list must include the reactive source, or the URL is written late and attributed to whatever gesture is open at that moment.
- `flushWrite`'s `history.state` place object grows a field. Nothing reads it back (`onPopState` re-parses), so no behaviour change.

*In `packages/web/src/App.vue`:*
- `applyAnchor`'s `changes` branch applies it. **An absent `whole` must turn the mode OFF, not leave it as-is** — the rule at `App.vue:222-224` is explicit, and without it Back stops one step short: the entry says "hunks", the app still shows whole, and the truthful rewrite puts it back into the entry the user was leaving.
- Order: set the whole-file key, then let the fetch land. Re-check `ctx.isStale()` after every await.
- `pendingAnchor` is typed `{ view, at }` and does **not** need widening: `whole` is a property of the anchor once it lands, applied by the same watcher, not a second dimension the parked anchor has to carry.

*In `packages/web/src/stores/repo.ts`:* the whole-file slot resets alongside `selectedCompareBase` at `:482-483`, or repo A's mode leaks into repo B's first URL write.

---

## 9. The freeze

**The trigger fires — on the author's leans, not on the problem statement.**

The problem statement alone does not clear the bar the search override set. `search-design.md:706-717` treats the sole author as "real users arrive" *when he asks for the thing by name, names the surface, and names the quality bar*. "Perhaps there should be a toggle/button", plus a constraint that rules out the obvious build, plus an admission that the ref question is unsolved, is a problem statement with an open middle. On that alone the answer is still no.

The leans change it. Lean 1 names the feature (*"a mode which does only hunks or does whole-file"*), names the surface (*"of the diff view"*), and answers the ref question (*"the diff view should ... internally function on basically 2 refs"* — i.e. inherit, do not pick). Lean 2 names the quality bar (*"F5 gets the user to the exact same view"*). That is the search precedent's bar, met. None of the other four §6 triggers fire, and none should be stretched — one `MonitorMap.vue` in one repo is emphatically not "a repo shape breaks something."

**What is lifted: one item, from the merit list.** `expanding context around a hunk` (`feature-review-0.9.0.md:122-126`).

**What stays rejected, re-confirmed by name:** widening Compare's base picker beyond remote branches; an ignore-whitespace toggle; marking a file as seen; filtering or sorting the changed-file set; a collapse-all for a large changeset. And the entire boundary list at `:132-135` — commit and other git mutations from the browser, conflict resolution, desktop notifications, a cross-repo journal or dashboard, **a free-text revspec box**, a journal query language, an onboarding wizard, a plugin system, anything AI-powered. Boundary rejections are the class the search override left completely untouched, and this must not be the thing that erodes them.

**The anti-escalation sentence**, which must appear verbatim in the doc:

> Accepting a whole-file mode does not buy incremental expansion, a context-line setting, or a ref vocabulary. The wire carries a boolean and the URL carries a flag; neither can express a number or a ref. Adding either is a new decision, not an extension of this one.

**The factual correction §3 needs.** `feature-review-0.9.0.md:83-94` rejected expand-context partly on *"this tool already has an Explorer and a view-file button one click away in the same app, which is most of what expanding context buys."* Every clause is true except the last. Verified: `GET /repos/:id/file` has no ref parameter and `readFileForDisplay` is `fs.stat` + `fs.open` on the worktree path; `FileContentPane` renders `FileForDisplay`, which has no status, no line pairs and no markers. The one-click workaround delivers content and forfeits **all** change information, and from History and Compare-committed it lands on a different file version than the diff was about without saying so. "Most of" was an honest hedge and the residue it excluded is the whole of what is being asked for. That correction goes in the doc whether or not the feature ships.

**Also amended, and flagged as an amendment rather than an extension:** the URL grammar's governing sentence (§8.2). Search amended one invariant (the corpus rule) and wrote its replacement down explicitly rather than bending it quietly. Same discipline here — the rewrite goes in `useUrlSync.ts`'s header, not only in this document, so the next person cannot cite `whole` as precedent for putting a preference in the address bar.

**What must be written down, non-negotiably:**

1. **`docs/whole-file-mode.md`** — this document, committed as written, with the override section naming the trigger and the evidence, the exact lift, the exact re-confirmations, and the anti-escalation sentence.
2. **`docs/feature-review-0.9.0.md` §4 and §6 amended in the same commit as the first feature slice**, matching the 2026-08-05 blockquote format and closing with the standing non-contagion line: *"Lifting one rejection does not open the rest. Everything else in this document still needs its own trigger."*
3. **`FEATURES.md`** (Views + Navigation) and **`CHANGELOG.md`**. The release script refuses without the latter.
4. **Namespace discipline, recorded:** no keybinding claimed; one URL key claimed (`whole`, `changes` only, widened with slice C); no prefs field claimed; and the reason for each.

---

## 10. Staging

**Slice 0 — defect fix, ships alone, no trigger needed. DONE.** Pin `-U3`
explicitly on `getDiff`, `getCommitDiff`, `getDiffBetweenRefs`,
`getCompareDiffWithUncommitted`. Closes a live `diff.context` leak the journal's
own comment already warns about.

Built as `DIFF_CONTEXT_LINES` in `packages/core/src/git/diff.ts` — one constant
rather than five literals, since `getDiffAgainstHead` already pinned its own and
a second copy of the same number is how they drift apart. Measured on a 16-line
fixture with two edits 12 lines apart: `diff.context = 20` merges them into one
hunk, the pin restores two. The tests in `diff.test.ts` assert 2 hunks through
every one of the five functions and were confirmed to fail (5 of them) against
the unpinned code.

Changelog must say it re-keys hunks once for anyone with `diff.context` set:
`hunkTimes` hashes a hunk's +/- body, so a re-split hunk is a new hunk with a
fresh edit time.

**Slice A — the ref-pair label.** `RefPairLabel.vue` on all four diff surfaces. Zero core, zero daemon, zero client, zero wire, zero URL. Answers constraint 2 on its own, and fixes a live ambiguity: with "include uncommitted" on, a Compare stack shows committed rows at `merge-base(base,HEAD) → HEAD` beside uncommitted rows at `HEAD → working tree` — two different bases in one stack, distinguished today only by an `[uncommitted]` tag that never mentions the base. Ship this first regardless of what happens to the rest.

**Slice B — whole-file mode in Changes, plus the way out of the Explorer.** The `whole` parameter, the store slot, the URL key and its header rewrite, the height-model fixes, `WholeFileToggle.vue`, `ShowChangesButton.vue`. This is the feature. **Defers:** Compare, History, per-side highlighting.

**Slice C — Compare and History.** Requires the rename-preserving pathspec pair on `/compare` and `/commits/:hash/diff`, the `commits`/`uncommittedCount` merge question, and an answer for `--row-h` on a standalone `DiffView`. Genuinely larger than it looks; do not fold it into B.

**Slice D — per-side document highlighting.** `runsFromHtmlLine`, two hljs calls per file instead of N, correct block comments and template literals. ~60 lines, one new function, one branch in `syntaxPieces`. The highest-value follow-up in this document.

Then stop.