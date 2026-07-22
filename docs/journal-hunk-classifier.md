# Journal hunk classifier + fold: recommended design

Delta to `docs/journal-design.md`. Everything in that doc's §2 (observation point, throw-on-error, double-oid read, store-above-manager, seq/ts split), §4 wire spine, and §5 scroll rules is inherited unchanged. This replaces §3's per-file classification with per-hunk lineage and replaces Decision 5 ("no coalescing") with a client-side fold. Decision 1 (file granularity) is superseded by user decree.

## 1. Recommendation

Lineage is **interval overlap in HEAD pre-image coordinates**, computed not on git's hunk-header ranges but on each hunk's **edit-run footprints** (deletion old-line ranges plus half-line-expanded insertion anchors) — the graft of proposal 1's overlap spine with proposal 3's run canonicalization, which closes the exact hole the judge broke proposal 1 on (a mixed add+delete hunk whose deletions-only span shadowed a still-alive insertion, producing a false revert + false create). Content is used only for the silence test: a djb2 `bodyHash` over +/- lines (the `hunkTimes.ts` `hashHunkBody` convention, `packages/core/src/git/hunkTimes.ts:12`) decides "unchanged, no entry" — never for matching. The fold is **client-side display-only**: the daemon stays strictly append-only, so `?since=seq`, epoch reset, refetch, multi-client, and disk-v2 JSONL all stay trivially correct; proposal 2's daemon-side fold was judged broken precisely where it claimed strength (a tip revised-then-frozen during a disconnection is unrecoverable under its own reconnect contract). The fold's one known mis-fold (a split child silently absorbed as a linear revision, proposal 3's break) is closed by a daemon-stamped `siblings` count — no lookahead, no key reorder, still append-only.

## 2. The classifier

### Canonical hunk data

Between boundaries HEAD is frozen, so the old side of every hunk is a coordinate in an immutable pre-image, per hunk independently: when hunk A grows, hunk B below it shifts only on the *new* side. `getDiffAgainstHead` must run `git diff -U3 HEAD --` — **pin `-U3` explicitly**, or a user's `diff.context` config changes hunk merge/split geometry between machines (test with `-c diff.context=0`).

Per file, the live map (in `JournalStore`, JSON-native) becomes:

```ts
interface LiveHunk {
  seq: number;                  // journal entry that last recorded this hunk
  runs: [lo: number, hi: number][]; // edit-run footprints, half-line HEAD coords, sorted
  bodyHash: string;             // djb2 over +/- lines only (context and headers excluded)
  ins: number; del: number;
}
// store.live: Map<path, LiveHunk[]>
```

**Run extraction** (the fiddly parse — table-test it): walk the hunk's `DiffLine`s maintaining the old-line counter, **skipping `\ No newline` lines** (`diffParse.ts` numbers them as context, which would drift every later anchor — proposal 3's judge verified this at `diffParse.ts:114`) and re-deriving counts from the `@@ -a,b +c,d` header (including `-0,0` new-file and `-N,0` forms). A maximal consecutive del/add group is one run:

- run with deletions of HEAD lines `d1..d2` → footprint `[2·d1, 2·d2]`
- pure insertion after HEAD line `A` → footprint `[2A, 2A+2]` (the ±half-line expansion: it "touches" both neighboring HEAD lines; `A = 0` at top of file)

A hunk's footprint is the **set** of its run intervals, not their hull — a hull could false-match a new edit landing in the untouched gap between two runs of one context-merged hunk.

Because `bodyHash` excludes context and line numbers, and because run footprints are HEAD coordinates, a hunk whose `@@ +newStart` shifted (an edit above it) hashes and locates identically. That is the "only changed hunks append" guarantee, by construction. Fast path per file: hash the file's raw diff slice first; equal to previous → the whole file is silent, skip everything.

### The pure function

```ts
classifyFileHunks(prev: LiveHunk[], next: ObservedHunk[])
  → { entries: PendingEntry[]; nextLive: LiveHunk[] }
```

Both sides are sorted and internally disjoint on the old axis (git guarantees it; within one U3 diff, distinct hunks are separated by more than the context width, so footprints of distinct same-side hunks never overlap). Match prev hunks to next hunks by **any run-interval intersection** (closed intervals: `lo1 ≤ hi2 && lo2 ≤ hi1`), one linear two-pointer sweep, O(n+m). No adjacency slack beyond the built-in ±half-line insertion expansion — git's own context merging already provides proximity semantics. Build connected components; per component:

| Component | Result |
|---|---|
| 0 prev, 1 next | append `created`, `supersedes: []` |
| 1 prev, 0 next | append `reverted` tombstone, `diff: null`, `supersedes: [p.seq]` |
| 1↔1, same `bodyHash` | **silent** — no entry; carry `seq` forward into `nextLive` with recomputed runs |
| 1↔1, hash differs | one entry, `supersedes: [p.seq]`, kind by size (§3) |
| 1 prev, N next (split) | N entries, **each** `supersedes: [p.seq]`, each stamped `siblings: N`; parent collapses once (derived-outdated tolerates multiple pointers) |
| N prev, 1 next (merge) | one entry, `supersedes: [all N seqs]` — every parent must retire or it dangles live |
| N↔M (rare) | every next entry supersedes all prev seqs in the component, `siblings: M`; honest over-supersession, never clever |

No separate lineage id: the `supersedes` chain **is** the lineage. `nextLive` = the next hunks' fresh `LiveHunk`s (silent hunks keep their old `seq`).

Whole-file transitions fall out: file newly in diff → all hunks `created`; file left the diff → **one** `reverted` entry superseding all its live seqs (not N tombstones). Rename with git-reported old→new: re-key the live map (the HEAD pre-image blob is content-identical, anchors stay valid), classify normally, append one file-scoped `renamed` marker; a similarity-detection flip-flop degrades to revert+creates, never a crash (doc B7 unchanged). Binary and mode-only files have no hunks: one pseudo-hunk per path (`runs: [[0, 2·MAX]]`, `bodyHash` over the raw) — file-level behavior for exactly those files.

**Two defer-don't-decide guards, inherited and extended:** (a) classification runs only on fully-successful observations (throw-on-error + double-oid, doc §2 verbatim); (b) **new**: `getDiffForUntracked` catches-to-empty (`diff.ts:114`), and zero hunks for a path that status still lists as changed would read as a phantom whole-file revert — if a path's status and its parsed hunks contradict, keep its live hunks untouched and emit nothing for it this tick. The boundary rule is unchanged and load-bearing: a HEAD move invalidates every footprint, so the silent rebaseline **recomputes** `LiveHunk`s against the new HEAD (same seqs, fresh runs/hashes); footprints are never compared across a boundary.

## 3. Kind derivation

- `created` — no predecessor in the component.
- `reverted` — no successor; tombstone, no body.
- Otherwise compare `ins + del` against the **sum over all superseded predecessors**: greater → `expanded`, smaller → `shrunk`, equal-but-different-hash → `edited`.

Split children compared against the whole parent typically read `shrunk` — cosmetically imperfect, never wrong content; accepted (the judge rated all greedy-pairing consequences cosmetic). One refinement lives client-side: a fold group's displayed kind is recomputed against the **pre-group baseline** (the entry the group's first member superseded, looked up by seq in the log; fall back to the latest entry's own kind if pruned). This is proposal 2's `frozenBodyHash` insight — kill keystroke-to-keystroke kind flip-flop — obtained with zero wire changes.

## 4. Fold window: client-side

**Choice: client.** The daemon log is strictly append-only; the fold is a pure projection `foldEntries(entries, FOLD_MS)` computed in the web view. Why: a daemon fold needs a mutable provisional tip, an upsert wire rule, and a reconnect story for revisions that land and freeze while a client is disconnected — proposal 2's own contract failed that timeline (rev-1 copy stranded forever after `?since` returns nothing). Client fold has no such states: refetch, `?since=seq`, epoch reset, and a second client all re-fold identically from the same immutable bytes, and disk v2 stays a JSONL you only append.

**Join rule** (walk in seq order, groups keyed by their first entry's seq — Vue keys never change): entry `e` joins group `g` iff

1. `e.supersedes.length === 1 && e.supersedes[0] === g.tipSeq`,
2. `e.siblings === 1` — **the split guard** (proposal 3's break: a split child carries a single-element `supersedes` and would otherwise absorb silently as a linear revision; `siblings` is stamped at append, so no lookahead and no retroactive ejection),
3. no boundary entry sits between their seqs,
4. `e.ts − g.tipTs ≤ FOLD_MS`, clamping negative deltas to 0 (mtime-clamped `ts` can be non-monotone; `seq` already proves order).

Merges (`supersedes.length > 1`), reverts, and boundaries end groups. A group renders as its **latest** entry at the latest entry's position (bottom — recent edits at the bottom), with a "×n" affordance expanding the chain; absorbing the previous tip reuses the doc §5 collapse rules unchanged (animate at/below viewport, snap + `useScrollAnchor` above; tail-pin untouched). `FOLD_MS = 15s`, per-gap, a client display pref — autosave lands roughly one observation per save, so 15s bridges pause-y typing while a long session on one hunk correctly stays one evolving blurb.

**Cost, owned:** the raw log records every autosave observation. Decision 8's caps move from polish into phase 2, refined: prune **bodies before entries**, and among bodies prune superseded entries' bodies first (`diff: null` is already legal; fold history degrades to stats stubs). Body-less rows are ~100 bytes, so entry caps bound memory without ever mutating semantics.

## 5. Delta to docs/journal-design.md

**Entry shape** — `JournalFileEntry` becomes `JournalHunkEntry` (boundary entries unchanged):

```ts
interface JournalHunkEntry {
  type: 'hunk';
  seq: number; ts: number;          // unchanged semantics
  path: string; status: FileStatus;
  kind: 'created' | 'edited' | 'expanded' | 'shrunk' | 'reverted' | 'renamed';
  span: { start: number; count: number };  // HEAD old-line footprint hull — drives "lines 10–14" label
  stats: { insertions: number; deletions: number };  // this hunk only
  diff: DiffResult | null;          // file header lines + the ONE @@ section; null for reverted/oversize/pruned
  supersedes: number[];             // was number|null — merges and whole-file reverts need plural
  siblings: number;                 // co-appended entries from the same component (1 = plain)
  seeded: boolean;
}
```

Still JSON-native; `serialize.ts` stays a pass-through. **Wire: unchanged** — same `GET /repos/:id/journal?since=`, same batched `journal-append` (one event per observation, now possibly several hunks per file), same epoch/`prunedBefore` protocol. **UI blurb:** header = path, "lines 120–134" (from `span`), kind badge, `+n −m`, relative time; body = the reused `DiffView.vue` fed the single-hunk `DiffResult` — `buildDiffModel` (`packages/web/src/utils/diffRows.ts`) treats a one-hunk diff as a normal mini-diff, word-diff and content-stable keys free. `contain-intrinsic-size` from the hunk's line count, fixed at append.

**Superseded in the doc:** §1's file-granularity argument and Decision 1; Decision 5 (fold now exists, client-side); §3's per-path classification list and the `live: Map<path, seq>` shape in §2 (now `Map<path, LiveHunk[]>`); `supersedes: number | null`. **Still stands verbatim:** the whole observation spine (§2: doRefresh piggyback at `WorkingTreeManager.ts:313`, throwing `getDiffAgainstHead` + double `getHeadOid`, untracked-inside-queue-slot, store-above-manager with reopen reconciliation), boundary-before-kind ordering and all of Decisions 2–4 and 6–10, §4 wire, §5 view/scroll/outdated rules, seeding (now per-hunk, mtime-ordered — `HunkTimeTracker` already stamps per hunk), and the B1–B13 table except where restated below.

## 6. Edge-case survival

- **Split:** middle of a context-merged hunk reverted → two entries, both superseding the parent, `siblings: 2`; parent collapses once; the split guard keeps the fold from absorbing a fragment as a "revision".
- **Merge:** edit in the gap between two live hunks → one entry superseding both seqs; both old blurbs collapse.
- **Revert one of many:** that hunk's runs match nothing → one tombstone; every sibling hunk is a silent 1↔1 identical-hash component — no re-append.
- **New hunk shifts line numbers:** edits above move only `@@ +newStart`; old-side footprints and `bodyHash` are untouched → provably silent (the user's two-files-two-blurbs example holds exactly).
- **Fold during typing:** each autosave observation appends one 1↔1 supersession; the client folds the chain into one evolving blurb with "×n"; group kind computed vs the pre-group baseline.
- **Commit mid-typing:** boundary-before-kind fires first — one divider, silent rebaseline recomputes every footprint against the new HEAD; no cross-boundary span comparison is reachable.
- **Transient truncation / unreadable untracked file:** throw-on-error skips the whole observation; the new untracked guard defers a status-vs-zero-hunks contradiction — no phantom tombstones, ever.
- **Reconnect:** entries immutable, order is seq → `?since=lastSeq` plus seq-dedupe is complete; the fold re-derives identically from the refetched prefix; epoch mismatch or `prunedBefore` gap → full refetch + "journal restarted" divider (doc B8/B9 unchanged).

## 7. Phased plan delta

Phase 1 (core classifier) changes shape: `classify(prevLive, observation)` becomes run-extraction + `classifyFileHunks` per file, with table tests for: run extraction (top-of-file, EOF, `-N,0`, `-0,0`, `\ No newline`, mode-only), the judge's mixed-hunk sequence (insert-then-nearby-delete-then-revert — must yield created → expanded → shrunk, never tombstone+create), split/merge/N↔M, silence under above-hunk shifts, the untracked defer guard, and `-U3` pinning under `-c diff.context=0`. Phase 5 gains `foldEntries()` as a pure, separately unit-tested helper (double-apply idempotence, split-guard, boundary-breaks-group, negative-Δts). Phases 2–4 and 6 are unchanged except `siblings`/`supersedes[]` in types.

**Prototype first:** the run canonicalizer + `classifyFileHunks` alone, fed a recorded trace of real `git diff -U3 HEAD` outputs captured every save during an actual autosave editing session (plus the scripted judge-break sequences), asserting lineage chains on stderr. It is the one component whose bugs are permanent in an append-only log, and the trace harness answers whether run footprints track a real typing session before any wire or UI exists.

## 8. Risks specific to hunk granularity

1. **Run extraction is the whole game** — a one-line anchor drift misclassifies lineage forever (append-only makes it permanent). It must own its line accounting, not reuse `parseDiffWithLineNumbers`'s.
2. **`-U3` unpinned** silently changes split/merge geometry per machine; enforce by test, like throw-on-error.
3. **Insertion adjacency weld:** the ±half-line expansion means insertions at anchors one line apart supersede each other — usually a nudged edit, occasionally welds two unrelated one-liners. Bounded to distance 1; accepted.
4. **N↔M over-supersession and split-child `shrunk` labels** are cosmetic imprecision, never wrong content; test the 2↔2 crossover, don't optimize it.
5. **Formatter sweeps:** every touched hunk legitimately appends; the fold cannot help across lineages. Doc-B5-class accepted noise; a later "&gt;K hunks in one file → one file-level entry" knob layers on with no wire change.
6. **Log growth under autosave** is real (client fold stores the churn): phase-2 caps with bodies-before-entries, superseded-bodies-first.
7. **The one classifier bug this design uniquely enables** — comparing footprints across a HEAD move — is forbidden by the rebaseline rule; assert structurally (classify is unreachable when the boundary check fired) and table-test amend/reset/rebase-autostash.