# Journal: recommended design

## 1. Recommendation

Build a **file-level, append-only journal of HEAD-axis diff snapshots, owned by the daemon**: each time `WorkingTreeManager.doRefresh()` observes a settled working tree, a new `JournalManager` (core, daemon-side) compares the per-file slices of `git diff HEAD` against its live map and appends immutable entries; "outdated" is never stored, it is derived from later entries' `supersedes` pointers. File granularity wins over hunk lineage because hunk identity across edits is the acknowledged bug magnet in both hunk-flavored proposals (the matcher, pure-insertion mis-pairing, partial-commit identity loss), while file-level reuses the existing per-file blurb renderer (`DiffView.vue`) and `splitDiffByFile` verbatim and still delivers exactly the UX the user described — same file appearing repeatedly, older versions collapsing. The HEAD axis (worktree vs HEAD, staging invisible) deletes the entire stage/unstage-noise bug class by construction; `seq`, not timestamps, defines order, deleting the reorder-on-rerender class. Two hardening moves that every proposal missed, and that the adversarial judging broke all three on, are load-bearing here: the journal's diff source **throws on error** instead of following `diff.ts`'s catch-to-empty convention (so a transient index.lock can never read as a mass revert), and the journal store lives **above the manager lifecycle** in a daemon-level map keyed by the stable `repoId` (so a browser F5 dropping the refcount to zero doesn't wipe the session's chronology — half the "we have a daemon now" value). Everything else — epoch + `?since=seq` reconnect, boundary-before-kind classification, batched `journal-append` SSE on the existing per-repo channel — is the graft of the strongest ideas across the three proposals.

## 2. Daemon machinery

**Observation point.** `WorkingTreeManager.doRefresh()` (`packages/core/src/managers/WorkingTreeManager.ts:313`) is already the single serialized funnel: chokidar → `GitOperationQueue.scheduleRefresh` → `doRefresh`, one body at a time per repo. The journal piggybacks there; it never watches anything itself.

Inside `doRefresh`'s existing `Promise.all` (line 332, already running both whole-tree diffs), add the journal inputs:

- `getDiffAgainstHead(repoPath)` — new fn in `core/git/diff.ts` running `git diff HEAD --`. Unborn HEAD falls back to the empty tree (`4b825dc...904`). **This function propagates errors.** Every sibling in `diff.ts` (catches at lines 81, 114, 175, 213, 363) swallows failure into `{raw:'', lines:[]}` — indistinguishable from "clean", which is exactly how all three proposals were broken (phantom mass-revert entries welded into an immutable log). Breaking the file convention here is deliberate and must be a documented, tested requirement.
- `getHeadOid(repoPath)` — `rev-parse HEAD`, read **twice**: once before the diff reads, once after. If the two reads differ, the tree moved under the observation (external commit/rebase mid-flight): discard the whole observation, no entries this tick. This closes the torn-window race that `GitOperationQueue` cannot close (it serializes daemon ops, not external git processes).
- `getDiffForUntracked` for untracked paths whose `mtimes` entry moved — fetched **inside** the queue slot (proposal 1 fetched them after, a torn read the judge flagged). Size-capped; failure → entry with `diff: null`, never a crash.

The journal inputs are gathered under their own try/catch: if any throws, `doRefresh` completes its normal state update but **emits no observation** — a skipped tick is always safe because the next observation re-derives everything from scratch. On success, after `updateState`, `WorkingTreeManager` emits one new typed event:

```ts
'journal-observation': [{ status, headDiff, headOid, stashCount, operationInProgress, mtimes, at }]
```

`WorkingTreeManager` stays journal-unaware; `GitStateManager` wires `JournalManager` as the listener, next to `workingTree`/`remote`. Never an unsubscribed `'error'` emit (house rule).

**`JournalManager`** (`packages/core/src/managers/JournalManager.ts`): splits `headDiff` per file with `splitDiffByFile` (moved from `packages/web/src/utils/splitDiffByFile.ts` into `core/view/` — it is pure; web imports it from core, deleting the duplicate), hashes each file's raw (djb2, same as `hunkTimes.ts`), and diffs against `live: Map<path, seq>` to classify and append. Emits `'append'` with the batch of new entries.

**Store outlives the manager.** The entries array, `epoch`, `nextSeq`, `live` map, and `lastHeadOid` live in a `JournalStore` object held by the daemon in a `Map<repoId, JournalStore>` (repoId = sha256 prefix of the worktree root, `repoRegistry.ts:24` — stable across restarts). `repoRegistry.openRepo` injects the existing store into the fresh `JournalManager`; `closeRepo` at refcount zero disposes the manager but keeps the store (LRU-capped daemon-wide). On re-open, the first observation reconciles: if `headOid !== store.lastHeadOid`, emit one boundary + silent rebaseline; otherwise classify normally (edits made while unobserved appear as ordinary mtime-stamped entries). Epoch is minted per **store**, so clients keep their cache across F5.

**Coalescing:** none beyond what exists. chokidar `awaitWriteFinish` (100ms) + `scheduleRefresh` dedup already collapse save bursts to one observation. One observation → at most one entry per file. No journal-own debounce to get wrong; the fold window stays a later knob (see Decisions §5).

**Timestamps:** `ts = min(file mtime, observation time)` — mtime-honest (the `HunkTimeTracker.mtimeOf` convention) so seeded and late-observed edits carry truthful times, clamped so clock skew can't stamp the future. **`seq` is the only ordering axis; `ts` is a display label.**

**Core vs daemon:** core gets `getDiffAgainstHead`/`getHeadOid`, the `journal-observation` event, `JournalManager`, `core/view/splitDiffByFile`, `types/journal.ts` (type-only importable by web/client under existing dep-cruiser rules). Daemon gets the store map, `routes/journal.ts`, the SSE fan-out in `sse.ts`, and (nothing in) `serialize.ts` — the entry shape is JSON-native so `toWire` is a pass-through.

## 3. Event/data model

```ts
interface JournalFileEntry {
  type: 'file';
  seq: number;                 // per-store monotonic; THE order
  ts: number;                  // epoch ms, mtime-clamped, display only
  path: string;
  status: FileStatus;          // at capture
  kind: 'created' | 'edited' | 'expanded' | 'shrunk' | 'reverted' | 'renamed';
  stats: { insertions: number; deletions: number };
  diff: DiffResult | null;     // snapshot; null for reverted, oversize (>256KB raw), pruned body, failed untracked read
  supersedes: number | null;   // seq of the prior live entry for this path
  seeded: boolean;
}

interface JournalBoundaryEntry {
  type: 'boundary';
  seq: number; ts: number;
  kind: 'commit' | 'checkout' | 'stash' | 'op-start' | 'op-end' | 'journal-start';
  label: string;               // short hash + subject, branch name, ...
  resolves: number[];          // seqs of live entries this boundary retires
}
```

**Append + supersede.** Entries are immutable; the log only grows. An entry is outdated iff a later entry's `supersedes`/`resolves` names its seq — derived, never flagged, so there is no update-vs-append race, no `journal-update` event, and REST refetch is always authoritative.

**Classification, in strict order (boundary checks first — this ordering is load-bearing):**

1. `operationInProgress` transitions → `op-start`/`op-end` boundaries; file journaling **suspended** in between (conflicted rebases produce garbage diffs).
2. `headOid` moved → one boundary (`commit` if the branch name held, `checkout` otherwise), `resolves` = seqs of entries whose files left the diff; every surviving file **rebaselines silently** (live map updated, raw hash refreshed, no file entries) — a base move changes raws without any user edit, and suppressing those fake "shrunk/edited" entries is why boundaries must precede kinds. A 30-file commit is one divider row, not 30 blurbs. Partial commits fall out automatically: the remainder rebaselines, later edits journal fresh.
3. Per path, HEAD stable:
   - in diff, no live entry → `created` (status `renamed` → `renamed`, superseding the old path's entry; a similarity-detection miss degrades honestly to delete+create).
   - in diff, live entry, raw hash differs → compare `insertions+deletions` vs predecessor: greater → `expanded`, smaller → `shrunk`, equal-but-different → `edited`.
   - left the diff → `reverted` (no body, supersedes the live entry) — **unless** stashCount rose this observation, in which case the disappearance folds into a `stash` boundary (heuristic; the *what* stays truthful even when the *why* label is wrong).
   - hash unchanged → nothing (pure line-shift / staging churn / no-op refresh is silent).

**Defer-don't-decide guard:** classification of a disappearance happens only in an observation whose inputs all succeeded (guaranteed by throw-on-error + double-oid-read). If a path's status and diff presence still look contradictory, the path stays live one more tick — deferral is always safe; wrong appends are forever.

## 4. Wire API

- **REST:** `GET /repos/:id/journal?since=<seq>` → `{ epoch, lastSeq, prunedBefore, entries[] }` in a new `packages/daemon/src/routes/journal.ts`. `epoch` is an **opaque string** minted per store — clients compare it with equality only (`===`/`!==`), never order or do arithmetic on it. `since` gives cheap catch-up; `prunedBefore` exposes ring-buffer eviction honestly.
- **SSE:** the existing per-repo channel (`packages/daemon/src/sse.ts`) grows a second listener on `manager.journal.on('append')`, writing `event: journal-append` with `{ epoch, entries }` — **all entries from one observation in one event** so clients apply atomically. Attached at channel creation, removed in `teardown()`, mirroring the `state-change` listener exactly. The `lastData` dedup stays on `state-change` only (appends are inherently new).
- **Client:** `DiffstalkerClient.journal(id, since?)` in `packages/client/src/client.ts`; `journal-append` added to the repo subscription event set (the web's `packages/web/src/api/client.ts` `subscribeRepo` likewise). The CLI's `RepoSession` ignores unknown SSE events — TUI untouched.
- **Reconnect / multi-client:** the journal is repo-scoped shared state; nothing per-client lives daemon-side. On reconnect (the web store's `recover()` path) the client refetches `?since=lastSeq`. Epoch mismatch (new store — daemon restarted or store evicted) or a seq gap → discard and full refetch, render a "journal restarted" divider. Events racing the initial GET dedupe by seq (apply only `seq > lastSeq`). Multiple clients simply share the append stream.

## 5. Web view

- **Rail:** `VIEW_NAMES` in `packages/web/src/prefs.ts:13` gains `'journal'` (the `isViewName` guard makes stale stored prefs fall back safely); `VIEWS` in `packages/web/src/stores/ui.ts:21` becomes Changes, **Journal**, History, Compare, Explorer; `ActivityRail.vue` needs only an `ICON_PATHS.journal` glyph (clock-over-lines) — the rail iterates `VIEWS`, so position comes free. **ChangesView/DiffStack are not touched.**
- **Store:** `stores/repo.ts` grows a `journal` shallowRef (`{ entries, lastSeq, epoch, prunedBefore, loaded }`), lazy `loadJournal()` on first tab visit (mirroring history/compare), `journal-append` in the SSE dispatch, reset in `open()`, refetch in `recover()`.
- **`views/JournalView.vue`:** one scroller, oldest at top, growing downward, keyed by `seq` — append-only means keys never reorder, the ideal keyed v-for. Each file entry: compact header (relative time, absolute on hover; path; kind badge; `+n −m`) over a reused **`DiffView`** fed the entry's `DiffResult` — zero new renderer, word-diff and themes free. Bodies get `content-visibility: auto` + `contain-intrinsic-size` from the entry's line count (fixed at append time, so the estimate never goes stale — simpler than DiffStack's live probe). Boundaries render as slim dividers ("committed a1b2c3d — 4 changes"); `seeded` entries render muted ("present when journal started"). Day dividers use `ts` and may repeat (seq order, mtime labels) — accepted.
- **Outdated treatment (the user's lean, made precise):** when an append's `supersedes`/`resolves` names visible entries, those flip to outdated: badge ("outdated 14:31"), body collapses to a one-line stub, click re-expands the stale snapshot (nothing is deleted client-side until the daemon prunes).
- **Collapse transitions without scroll bugs** (proposal 3's rule, the cleanest): collapses **at or below** the viewport top animate (`grid-template-rows: 1fr → 0fr`, ~200ms, off under `prefers-reduced-motion`); collapses **entirely above** the viewport snap instantly inside one Vue flush, compensated by a `useScrollAnchor` pre/post sandwich (candidates = entry elements keyed by seq — a strict subset of DiffStack's wiring). Animating above-viewport height is exactly the out-of-flush change the anchor cannot track per frame, and the user cannot see it anyway — delete the bug class rather than fight it. Appends land below everything: nothing above moves. A pinned-to-bottom tail mode (within ~40px of the end) auto-follows; otherwise an "N new ↓" pill.

## 6. Decisions for the user

1. **Granularity: file-level** (one entry per file per observation). Why: hunk lineage matching is the single biggest bug source in the alternatives, and the blurb renderer is per-file anyway. Alternatives: hunk-level lineage (richer supersession, much harder matcher); per-file with changed-hunks highlighted (possible later on top of the same wire).
2. **Axis: worktree-vs-HEAD; staging is journal-invisible.** Why: the journal records *when edits arrived*; `git add` moves nothing the user wrote, and a staged/unstaged axis doubles every staging action into noise. A reserved `side` field ('head' in v1) keeps refinement possible. Alternative: separate staged/unstaged timelines (rejected as pure churn).
3. **Full revert: explicit tombstone** — a `reverted` entry appends below, prior entry collapses. Why: chronology is the point; silent disappearance loses the event. Alternatives: mark-only (no new entry); delete entries (contradicts append-only). Daemon-initiated discards journal identically, no cause tag in v1 (with multiple clients a tag can't say *who* anyway).
4. **Commit: one boundary divider resolving the vanished entries**, survivors rebaseline silently. Why: a 30-file commit must not be 30 blurbs, and rebaselining suppresses fake "edited" storms. Amend/reset/rebase get the same HEAD-move treatment. Alternatives: per-file `committed` markers (noisy); clearing the journal (loses the day's narrative).
5. **Coalescing: none in v1** beyond the existing 100ms write-finish + queue dedup; the collapse-outdated UX is the churn absorber. Why: any fold window mutates the tip and breaks the append-only invariant that makes SSE, reconnect, and multi-client trivially correct. Alternative: a 2–30s daemon-side fold (reference Q8) — the right later knob **if** autosave-while-typing (an entry every few seconds, each superseding the last) feels like churn in practice. This is the one decision best made after using it.
6. **Persistence: in-memory per daemon lifetime, but the store survives repo close/reopen** (daemon-level map keyed by repoId). Why: closing the last browser tab must not wipe the session's chronology — that guts the "daemon owns it" rationale; full disk persistence (JSONL under the XDG state dir) drags in schema versioning and is a clean v2 precisely because entries are immutable. Alternatives: manager-lifetime only (F5 wipes it — rejected); disk in v1. **Is journal-survives-daemon-restart a v1 requirement for you?** I say no; the UI shows "journal started 14:02".
7. **Seeding: on first observation, one `seeded: true` entry per changed file, mtime-stamped, appended in mtime order.** Why: an honest reconstructable initial chronology instead of a wall of "just now". Alternatives: stamp "now" (dishonest); start empty (hides existing work).
8. **Outdated visual + pruning: keep outdated entries as expandable stubs; ring buffer of 500 entries / 16MB of snapshot raw per repo, evicting oldest outdated bodies first, then entries; `prunedBefore` cap row in the UI.** Why: full time-travel requires storing every snapshot — the caps bound that honestly. Alternatives: stats-only for outdated (cheaper, no re-expand); unlimited (growth bomb on a week-old daemon).
9. **Stash: boundary via the stash-count heuristic; pop re-materializes files as fresh entries.** Why: cheap and usually right; when a stash and an unrelated revert coalesce into one observation the *label* can be wrong but the content record stays truthful. Alternative: correlate with the daemon's own stash mutation for a confident tag (coupling; external stashes stay heuristic regardless).
10. **Branch switch: one `checkout` boundary + silent rebaseline, per-repo journal (not per-branch).** Why: the alternative is an N-revert + M-create storm on every checkout; per-branch journals multiply state and confuse append-only. Alternative: the honest storm (available later behind a toggle if wanted).

## 7. Edge-case survival (reference doc B1–B13)

- **B1 rapid double edit:** one settled observation → one entry; intermediate states are unobservable by design (the journal logs observed snapshots, never keystrokes — say so in the UI).
- **B2 revert then re-edit to identical content:** the live map keys off *latest* state, not any-hash-ever; the chain is edited → reverted → created, three honest entries.
- **B3 edit, commit, re-edit identical:** the commit boundary clears the live entry; the byte-identical re-edit correctly appends fresh (commit is a hard barrier by rule order).
- **B4 two files, one tick:** one observation, per-file entries with distinct seqs assigned under queue serialization, batched in one SSE event; seq orders, equal `ts` is fine.
- **B5 write-then-truncate:** mostly hidden by `awaitWriteFinish`; a git-watcher-triggered mid-write observation can still journal a giant delete + re-add ~200ms later. Accepted noise in v1 (two honest-if-ugly entries), flagged as the candidate for a fold-away suspicion window later.
- **B6 binary flip:** the entry stores whatever `DiffResult` git gave (binary = no hunks); `DiffView` already renders the no-hunk case; no word-diff attempted on it.
- **B7 rename:** `renamed` entry at the new path superseding the old path's entry; a detect/no-detect flip-flop across refreshes degrades to delete+create — tolerated, never crashes classification.
- **B8 reconnect mid-burst past eviction:** `?since=seq` + `prunedBefore` gap detection → full refetch, no silent hole.
- **B9 daemon restart, warm tree:** new store → new epoch → client discards and accepts the reseeded journal; "journal restarted" divider; no seq interleaving.
- **B10 two clients, one manager:** shared append stream, no per-client daemon state; no "who did it" cause tags; refcount-zero no longer destroys the journal (store outlives the manager, §2).
- **B11 transient git error reads as mass revert — the killer:** `getDiffAgainstHead` throws, the observation is skipped, the classifier never sees a swallowed-empty diff; the double HEAD-oid read discards torn windows; disappearances classify only from fully-successful observations. This is the fix all three proposals lacked.
- **B12 status-only refreshes:** journal advances only on full `doRefresh`; late-observed edits are backdated via mtime (`ts = min(mtime, at)`).
- **B13 branch switch / rebase / stash-pop:** HEAD-move → boundary + silent rebaseline; `op-start`/`op-end` suspend journaling through conflicted operations; stash via the count heuristic.

## 8. Phased implementation plan

**Prototype first (the de-risk):** phase 1 alone, run against a real repo with a real editor (autosave on), logging entries to stderr. It answers the two open empirical questions — does throw-on-error + double-oid-read actually keep the log clean through external `git commit`/`stash`/`checkout` in a terminal, and does one-entry-per-refresh match the felt rhythm of typing — before any wire or UI exists.

1. **Core observation + classifier** (`packages/core`): `getDiffAgainstHead` (throwing) + `getHeadOid` in `git/diff.ts`; `journal-observation` in `WorkingTreeManager.doRefresh`; `types/journal.ts`; `JournalManager` with the classifier as a **pure function** `classify(prevLive, observation) → entries` — table-driven tests for every §7 row (revert-vs-torn-read, commit-mid-edit, rename flip-flop, stash coalescence, unborn HEAD). Move `splitDiffByFile` to `core/view/`, point web at it. Lands green standalone.
2. **Daemon store + wire** (`packages/daemon`): `Map<repoId, JournalStore>` with reopen reconciliation and LRU cap; `routes/journal.ts`; `journal-append` fan-out in `sse.ts` with teardown; README endpoint table row. Tests: epoch/since/prunedBefore protocol, store survival across close/reopen, F5 simulation.
3. **Client** (`packages/client`): `journal()` method + `journal-append` in the subscription types; wire decode is a no-op. Parallel with 4.
4. **Web store** (`packages/web/src/stores/repo.ts`): journal slice, lazy load, SSE apply with seq dedupe, `recover()` refetch, epoch/gap handling. Parallel with 3.
5. **Web view**: `prefs.ts` + `stores/ui.ts` + `ActivityRail.vue` rail insertion; `views/JournalView.vue` with `DiffView` reuse, stubs/boundaries, tail-pin, and the animate-below / snap-and-compensate-above collapse rules on a fresh `useScrollAnchor` instance.
6. **Polish**: pruning caps + cap row, huge-file "Load diff" gate reuse, `FEATURES.md`, `docs/` note next to `web-diff-stream-architecture.md`.

## 9. Risks and bug-prone spots

1. **The diff-acquisition boundary stays the top risk.** Throw-on-error must be enforced by tests, not convention — a future refactor "normalizing" `getDiffAgainstHead` to the file's catch-to-empty style silently reintroduces the phantom-mass-revert bug. Add a test that asserts it rejects on a locked repo.
2. **Boundary-before-kind ordering is the classifier's spine.** Amend, `reset --soft/--hard`, rebase-autostash each move HEAD and the worktree in one observation; any path that classifies kinds before checking HEAD movement journals fake edits. Every such scenario needs a table test. Cost of the rule: an edit racing a commit into the same observation is swallowed by the rebaseline — the right trade, but document it.
3. **Append-only means garbage is forever.** Every guard is therefore "defer, don't decide": skip the tick, stay live, let the next observation re-derive. Any temptation to append on partial information is a bug.
4. **Stash/revert/checkout-one-file ambiguity:** observationally similar; labels are best-effort, content records are truthful. Don't over-engineer the heuristic.
5. **Store-above-manager lifecycle** is new machinery: reopen reconciliation (HEAD moved while unobserved → boundary) and the daemon-wide LRU need their own tests, or a stale store poisons a fresh session.
6. **Event-order coupling:** `journal-append` and `state-change` fire from one observation; verify no web code assumes an arrival order.
7. **Two sources of "when":** `hunkTimes.ts` stamps hunks for Changes, the journal stamps files — they will occasionally disagree on screen. Don't couple them in v1; consider deriving hunk times from the journal later.
8. **mtime honesty limits:** formatters, `touch`, and checkouts rewrite mtimes; seeded labels can read "just now". `seq` is the only truth; the UI must visibly order by arrival and tolerate non-monotone time labels.
9. **Scroll compensation** is the main UI risk; the animate-below / snap-above split shrinks the surface, but the ResizeObserver interplay with `useScrollAnchor` during a mid-viewport collapse deserves a manual test pass with the tail pinned and unpinned.