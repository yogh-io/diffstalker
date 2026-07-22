# Journal approach: secondary-review verdict

## 1. Bottom line

The approach is **fundamentally correct — but incomplete as shipped**. All five reviewers independently landed on "sound-with-caveats": the per-hunk HEAD-footprint lineage model, the observe-on-doRefresh capture pipeline, the epoch/since/prunedBefore sync protocol, and the client fold each survived adversarial tracing against real git output — including a 9-session empirical harness run over the shipped classifier code. The early compile/epoch/reconnect bugs were surface bugs, not symptoms of a rotten core. What IS missing is one designed-but-unshipped piece (pruning, design decision 8) and a handful of race-window guards; those are completions of the design, not corrections to it.

## 2. Genuine design flaws (approach-level, should change)

**a. Tear guard is HEAD-only; slow external ops produce permanent phantom storms.** `git checkout` on a big repo writes the worktree over ~2s while HEAD moves last; the 100ms git watcher fires an observation whose before/after oid reads both see the OLD oid, so the guard passes and a half-updated worktree is classified as hundreds of phantom created/edited entries — permanent garbage in an append-only log for a routine branch switch. Same window lets external `git stash` mislabel disappearances as per-file "reverted", and an external merge's conflict markers get welded as user edits. **Change:** widen the settle guard to the same double-read pattern already used for the oid — re-read operationInProgress, stash count, and changed-file mtimes AFTER the diff, defer if anything moved. Defer-don't-decide is already the design's shape; the guard just covers too little. (WorkingTreeManager.ts:330-436, JournalManager.ts:589-607)

**b. The "F5 drops refcount to zero" premise is false.** No pagehide/sendBeacon release exists in packages/web (verified by grep), so a web reload leaks a ref (1→2→3…) and the daemon never closes web-touched repos — watchers run forever, and the store-above-lifecycle machinery (JournalStoreCache, LRU-32, reinjection) that motivated half the design is unreachable in real web use. **Change:** release on pagehide via sendBeacon, or tie web refs to SSE liveness; at minimum fix the misleading comments. (repoRegistry.ts:31, stores/repo.ts:410)

**c. Post-sweep degeneracy (accepted cost, ship the knob sooner).** After a formatter sweep the whole file is one git hunk, so every autosave until the next commit appends a full-file snapshot whose blurb ("lines 1–400, +400/−400") hides the actual keystroke. Inherent to snapshot-over-git-geometry, heals at commit, and per-file granularity would be strictly worse — but it's the one realistic session shape where the journal stops being readable. Render >K-line entries as a collapsed file-level row.

## 3. Real correctness bugs — fixable details, prioritized

1. **Pruning does not exist** (three reviewers independently flagged it serious; spot-check confirms: `JournalManager` only ever pushes, `journalPrunedBefore` derives a gap nothing creates). The design explicitly rejected "unlimited" as "a growth bomb on a week-old daemon" — that rejected alternative is what shipped. Realistic math: reformatted 2000-line file + 2s autosave ≈ 240MB resident per hot file, all shipped to every fresh client and re-folded O(n) per append in the browser. The whole client protocol for prunedBefore is dead code that will first execute in production. **Fix:** implement decision 8 in `doObserve` (null superseded bodies past byte budget, then evict oldest past count cap), plus a daemon test driving a client resync across a real prune boundary.
2. **`journal-append` SSE carries no epoch** (confirmed: sse.ts ships `{entries}`, design specified `{epoch, entries}`). Appends racing an epoch-reset resync are silently dropped — a permanent hole (e.g. seq 9 lost while the full refetch built [1..8]). Fix: add epoch to the event; drop/buffer mismatched batches.
3. **Resync watermark lost on interrupted recovery** (confirmed: repo.ts:476 captures `journalSince` from the live tail). Double-disconnect: gap 51..59 unfetched, live appends advance the tail to 62, recovery #2 resyncs since=62 — permanent silent hole, masked downstream by the fold's pruned-baseline fallback. Fix: a `journalSyncedTo` watermark advanced only on successful resync.
4. **Duplicate untracked section corruption:** external `git add` between status and diff makes `appendUntrackedSections` emit a second section for a path already in headDiff; `splitDiffByFile` merges them into a corrupt hunk (headers counted as insertions). Fix: skip status-untracked paths already present in headDiff.
5. **Refresh coalescing hole:** full and status-only refreshes share one `refreshScheduled` flag; a stage+commit within ~200ms can fold an edit silently into the commit boundary. Currently healed only by the accidental redundancy of the index poller. Fix: separate slots, full upgrades pending status-only.
6. **Oversize untracked files (>256KB) are deferred forever** — never journaled, contradicting the `diff:null` promise. Fix: synthetic header-only entry.
7. **Label polish:** pure deletions badge as "expanded" (deriveKind compares gross churn); span labels are HEAD pre-image coordinates ("lines 0–1" at top-of-file, growing drift vs editor lines — derive labels from the new-side @@ header); "N new" pill counts folded revisions, not rows; rename markers are immortal unfoldable rows; `expandedStale`/`expandedChains` survive an epoch reset.

## 4. What is actually sound (with evidence)

- **The lineage model itself.** The empirical harness ran the shipped classifier verbatim over real `git diff -U3` output across 9 sessions: untouched hunks stay silent by construction; autosave growth folds 1↔1 cleanly; multi-cursor edits keep 5 independent per-site lineages (strictly better than per-file); the feared formatter fragmentation storm does not occur (git merges to one hunk); merge/split churn is bounded and mirrors git's own geometry. This plus the earlier 6/6 real-git trace is real validation, not doc optimism.
- **The observation pipeline's core invariants.** Re-derivation from scratch each refresh + same-bodyHash silence makes duplicate events harmless by construction; transient git errors defer rather than classify; `ts=min(mtime, at)` keeps late captures honest.
- **The sync protocol's shape.** SSE dedupe-by-seq, capture-tail-before-resubscribe, epoch-mismatch wholesale replace — the daemon store is genuinely the single source of truth; the holes above are gaps in the guards around this design, not in it.
- **The fold delivers the asked-for UX.** All three intents (bottom-recency, one-evolving-autosave-entry, outdated-stub-above/new-below) confirmed by trace against shipped code and table tests; the 15s window is the single coherent reading of the combined ask, and it's a pure client knob.
- **The view is freeze-safe by construction.** No RO/IO exists; the scroll-write graph has no edge back into the watchers; outdated derivation is O(n)-cached, not quadratic. Verified by grep and read, not assumed.

## 5. Recommendation

**Proceed after fixes.** Do not reconsider the approach — five independent adversarial passes, including an empirical harness, failed to break the model; every serious finding is a missing guard or an unshipped designed piece with a known fix that fits inside the existing shape.

Must-fix before calling the feature done (roughly in order):
1. Pruning (decision 8) daemon-side + a real prune-boundary client test — this single cap bounds daemon memory, wire size, and browser cost.
2. Epoch on `journal-append` + epoch-aware apply/merge client-side.
3. `journalSyncedTo` watermark for interrupted recovery.
4. Widened settle guard (op-in-progress, stash count, mtimes re-read after the diff) — kills the checkout/stash/merge phantom class.
5. Duplicate-untracked-section skip.
6. Web unload release (or SSE-tied refs), or at least honest comments.

Should-fix soon: refresh-slot split, oversize-untracked stub, deletion kind label, new-side line labels. Defer by choice: FOLD_MS tuning, sweep-collapse knob, undo-peek fold, pill wording — all client-only, best decided after real use.