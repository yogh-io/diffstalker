# Web perf/stability hazards: fix plan

## 1. Root cause of the scroll freeze

The tall-stack scroll hang is a two-layer problem. Both layers are live in HEAD; only one is fixed, and only in an uncommitted diff.

**Layer 1 — the loop (the hard freeze with content-visibility on).**
`DiffStack.vue` bodyRo callback (HEAD version) calls `anchor.nudge(delta)` for bodies above the viewport, which writes `scrollerEl.scrollTop += delta` (`useScrollAnchor.ts:213-218`). The scrollTop write moves the content-visibility:auto realization boundary; bodies above toggle between their computed `contain-intrinsic-size` and their realized height. Because those two heights **always disagree** (see the drift below), every toggle is a nonzero delta, so bodyRo fires again with a fresh delta, writes scrollTop again, moves the boundary again. RO delivery + forced layout every micro-cycle livelocks the renderer — even `setTimeout` starves. This is the observed hard freeze.

The delta source that arms the loop is exact-height drift, which is provable from the code:
- `DiffView.vue:372` hardcodes row-level `contain-intrinsic-size: auto 1.26rem` (20.16px) while `exactBodyHeight` (`DiffStack.vue:355-372`) sums the probed rowH (13px x 1.55 = 20.15px) — two constants for the same row, ~12-25px drift per 1000 rows depending on browser/zoom.
- `.diff-scroll` is `overflow: auto` with `width: max-content` rows (`DiffView.vue:219-233, 362-367`), so any wide-line file adds ~15px of horizontal scrollbar height on classic-scrollbar platforms that `exactBodyHeight` never counts (the probe's lines are 3-4 chars).
- Skipped rows also collapse intrinsic **width** (one-value c-i-s applies to both axes), so scrollbar presence itself flips as rows realize.

**Layer 2 — the freeze with content-visibility disabled (the injected-CSS repro).**
`useStackScroll.ts` ensureOffsets (`:156-164`) rebuilds by reading `el.offsetTop` for every section whenever the cache was invalidated. Three producers null it repeatedly: bodyRo on every drifting realize/derealize, the post-flush files watcher on every SSE commit (`DiffStack.vue:535`), and resize. Once invalidated every frame, each frame's runSpy forces a full-stack synchronous layout. With c-v off, that layout spans the entire un-contained stack of max-content grid rows — a single pass measured in seconds-to-minutes, during which no timer fires. This is why the freeze survived disabling content-visibility.

**Definitive fix (three parts, all required):**
1. Commit the working-tree bodyRo change (callback only updates bodyHeights + `invalidateOffsets()`); **delete `nudge()` entirely** from `useScrollAnchor.ts` (interface :95, impl :213-218, docs :28-33, :92-94) plus its tests, so the observer-writes-scrollTop pattern cannot be re-wired.
2. Kill the drift so bodyRo goes quiet during scroll: publish the probed rowH as a CSS var (`--row-h`) from measureProbe and use `contain-intrinsic-size: auto var(--row-h, 1.26rem)` in `DiffView.vue:372` and `FileContentPane.vue:206`; make the horizontal scrollbar deterministic (`overflow-x: scroll` on `.diff-scroll` + a once-probed scrollbarH added to `exactBodyHeight` for wide files, or a model-computed `min-width` in ch on `.hunk` so width no longer depends on realization). Success criterion: the DEV `assertBodyHeights` stops warning on wide-line diffs.
3. De-starve the offset cache: never rebuild synchronously inside the scroll frame while invalidations are arriving — or better, compute section offsets arithmetically from the `exactBodyHeight` model (zero DOM reads, immune to churn) in `useStackScroll.ts:156-164`.

## 2. Confirmed FREEZE/CRASH hazards

Ordered most severe first. Items 1-3 are the scroll-freeze cluster from section 1, restated as work items.

**F1. bodyRo -> nudge scrollTop loop (freeze — LIVE IN HEAD).**
`DiffStack.vue:560-584`, `useScrollAnchor.ts:213-218`. Fix exists only as an uncommitted diff. Commit it; delete `nudge()` and its tests; keep the in-callback comment explaining RO callbacks must never write scrollTop over c-v bodies.

**F2. ensureOffsets full-stack forced layout per scroll frame under churn (freeze).**
`useStackScroll.ts:156-164, 174-181`; invalidators at `DiffStack.vue:535, 572`. Fix: dirty-flag + at-most-once-per-quiet-rAF rebuild, or arithmetic offsets from the height model.

**F3. Quadratic word-diff on huge single lines (freeze — minutes).**
`diffPrimitives.ts:66-87` (core), reached via `diffRows.ts:249`. A rebuilt .min.js/.map is 2 changed lines (passes the 1500-**line** gate at `DiffStack.vue:121`) but `areSimilarEnough` runs fast-diff over the full pair: measured 8.4s at 73KB, ~quadratic. Fix: in `pairChangeRuns`, skip word-diff when either side exceeds ~1000 chars (mark whole line changed); compute fastDiff once and derive both similarity and segments from it.

**F4. Teleport crash cascade — the observed `__vnode`/`emitsOptions` errors (crash).**
`ExplorerView.vue:236`, `CompareView.vue:272, 347`, target in `ActivityRail.vue:61`. An enabled Teleport whose `#view-toolbar-slot` target isn't in the document yet (HMR root remount in portrait, tests, any future first-patch view mount) mounts children nowhere; every later patch runs against null-el children — verified against installed vue 3.5.40, and the target is never re-resolved. Fix: add `defer` to all three Teleports; belt-and-braces, move `#view-toolbar-slot` into `index.html` (also fixes the ActivityRail-HMR ghost-toolbar case that `defer` cannot cover).

**F5. Unbounded synchronous mounts (freeze-class long tasks), three siblings:**
- *Activation single commit*: `repo.ts:685-719` lands the whole repo's diffs in one `commitWorkingDiffs`; one flush builds every model **twice** (DiffStack memo + `DiffView.vue:53`) and mounts ~500k DOM nodes. Fix: commit in viewport-order chunks (~10 files per task); make `survivingKeys` lazy (only sections with a DOM el); share the model (see J2).
- *No total row budget*: `DiffStack.vue:121, 748-822` — 200 files x 800 lines each passes the per-file gate; ~800k nodes in one patch. Fix: cumulative row budget (~20k rows), force the rest into the "Load diff" unloaded state.
- *History commit diff has no gate at all*: `HistoryView.vue:282` hands the full commit diff to a bare DiffView — a lockfile commit blocks for seconds, a minified-asset commit also hits F3 ungated. Fix: route through DiffStack or add the same per-file/total gate to DiffView.

## 3. JANK / performance hazards

**Group A — content-visibility drift and probe (the scroll-path janks; mostly covered by section 1's fix 2).**
- Row c-i-s constant + h-scrollbar height + intrinsic-width collapse: fixed by the `--row-h` var, deterministic overflow-x, and ch-based min-width (files: `DiffView.vue:362-373`, `DiffStack.vue:355-372`). Also add the `auto` keyword to the body-level `containIntrinsicSize` string so remembered realized sizes win on re-skip (`DiffStack.vue:801-811`).
- `measureProbe` publishes a fresh `probeSizes` object even when all six values are identical (`DiffStack.vue:300-331`): every split drag / resize / scrollbar-toggle tick re-renders the whole stack and drops the offset cache, doubled by the raw window-resize listener (`:637`). Fix: epsilon compare-before-set; bail without assigning or invalidating. This also de-fuses a latent RO livelock if rows ever wrap.
- Probe constants changing for real (zoom, font swap) resize every skipped body with **no** anchor compensation — the likely "auto-scroll on load drops into the danger zone" contributor (webfont finishes after the auto-glide). Fix: sandwich the probeSizes write with `anchor.prepare`/`restore` like a files commit (`DiffStack.vue:516-546` machinery reused).
- DEV `assertBodyHeights` (`DiffStack.vue:605-626`): cheap once drift is fixed; rate-limit the warning per key rather than gating the assert.

**Group B — duplicated model building.** `buildDiffModel` (incl. word-diff) runs 2-3x per diff change across three disjoint caches: `DiffStack.vue:44-55`, `DiffView.vue:53` (no memo, no staged flag), `repo.ts:122-125, 833-840`. Fix: one `(DiffResult, staged)`-keyed memo exported from `utils/diffRows.ts`; DiffView accepts a prebuilt model or uses the shared memo; delete the duplicates. Impact: halves main-thread model cost exactly where frames are tight.

**Group C — store/SSE commit storms.**
- Per-file diff responses commit one-by-one (`repo.ts:575-585, 626-630`): up to 30 flush cycles per burst, each with an anchor sandwich + forced layout. Fix: buffer into a pending map, one `commitWorkingDiffs` per microtask/frame.
- Compare re-pull has zero identity preservation (`repo.ts:916-941`): every state-change rebuilds every compare model incl. word-diff — reads as a freeze on big branch diffs. Fix: reuse old DiffResult objects when `raw` is unchanged, like `applyTreeSide:741` does.
- `refreshAllDiffs` is not single-flighted (`repo.ts:774-777`): overlapping whole-tree pulls during branch switches. Fix: same guard + rerun-once latch as activation; skip untracked refetch when mtime unchanged.
- History reload wipes selection and re-fetches the commit diff on every state-change (`repo.ts:464-466, 853`; `HistoryView.vue:99-108`), flickering the detail pane; log re-pull continues even while History is unmounted. Fix: re-anchor `selectedCommit` by hash in the store, keep `commitDiff` when the hash survives, reuse CommitInfo objects on hash match.

**Group D — ticker.** DiffView's 1s edit-time interval re-renders the entire diff vnode tree per tick, per stamped file, for 60s after each save (`DiffView.vue:88-101, 157-190`) — landing in the scroll-jank zone. Fix: move the time label into a tiny child component reading one shared module-level ticker ref, or `v-memo` the row v-for.

**Group E — hidden-tab tween.** No `visibilitychange` handling anywhere; an auto-mode jump while hidden creates a tween whose rAF never fires, so `isTweening()` stays true for the whole background period — anchor compensation withheld (`useScrollAnchor.ts:208`) and spy suppressed (`useStackScroll.ts:173`) for every SSE commit. Mostly self-heals on refocus, but if the target vanished, the accumulated drift is never corrected. Fix: in `scrollToTarget`, take the instant path when `document.hidden`; add a visibilitychange listener that finalizes/cancels an in-flight tween (`useStackScroll.ts:225-289`).

**Group F — smaller confirmed items.**
- Focus recovery calls `row.focus()` without `preventScroll` (`ChangesView.vue:219-232, 211-214`; `ExplorerView.vue:109-116, 166-181`) — column yank under churn. Fix: `focus({ preventScroll: true })` everywhere, reveal via the existing scroll helpers.
- Duplicate section keys on typechange diffs (`diffRows.ts:180-182`): two sections share `u:<path>`, leaking one orphaned DOM section per re-render. Fix: ordinal-dedupe section keys like `hunkKeyFor`; hoist the hunk-key seen-map to model scope.
- Explorer highlights up to 1MB synchronously (`FileContentPane.vue:35-40`, `highlight.ts:114`). Fix: escaped plain lines first, chunked highlight swap-in.
- FinderOverlay synchronous fzf: measured up to 1.7s/keystroke at 100k paths (`FinderOverlay.vue:70, 92`). Fix: `AsyncFzf`.
- Splitter drag: capture the container rect on pointerdown, rAF-throttle the ratio write (`useSplitDrag.ts:108-116`).
- Reconnect race: SSE error during `recover()` leaves the store silently disconnected (`repo.ts:391-397, 410-433`). Fix: detect loss-during-recovery and re-schedule.

## 4. Recommended fix sequence

Each step lands green on its own. "Safe headless" = verifiable with unit tests/build; "needs browser" = confirm later in a live tall-stack session.

1. **Commit the bodyRo fix + delete `nudge()`** — `DiffStack.vue`, `useScrollAnchor.ts` + tests. Smallest possible step; HEAD currently ships the freeze. Safe headless (existing anchor tests adjust); browser confirm later.
2. **Teleport `defer` x3 + move slot to index.html** — `ExplorerView.vue`, `CompareView.vue`, `ActivityRail.vue`, `index.html`, `testing/portrait.ts`. Kills the crash cascade. Safe headless (component tests exercise portrait mounts).
3. **Word-diff char cap + single fastDiff call** — `packages/core/src/view/diffPrimitives.ts`. Unit-testable with a synthetic giant line. Safe headless.
4. **Drift elimination** — `--row-h` var + `auto` keyword + deterministic h-scrollbar (`DiffView.vue`, `FileContentPane.vue`, `DiffStack.vue`). Success = DEV assert silent on a wide-line diff. Needs browser verification (the assert is the instrument).
5. **Offset-cache de-starvation** — `useStackScroll.ts` (dirty-flag rebuild or arithmetic offsets). Unit-testable for the arithmetic variant; needs browser scroll test for feel.
6. **measureProbe equality bail + probe-write anchor sandwich** — `DiffStack.vue`. Safe headless for the bail; sandwich needs browser (zoom/font-swap check).
7. **Shared model memo** — `utils/diffRows.ts`, `DiffView.vue`, `DiffStack.vue`, `repo.ts`. Safe headless; existing tests cover model output.
8. **Store batching + identity preservation** — `repo.ts` (batched `commitWorkingDiffs`, compare raw-reuse, single-flight `refreshAllDiffs`, history hash re-anchor) + drop the HistoryView re-select watcher's re-fetch. Safe headless (store tests with fake client).
9. **Mount bounds** — activation chunking + total row budget (`repo.ts`, `DiffStack.vue`, `ChangesView.vue`) and the History gate (`HistoryView.vue`). Needs browser verification on a big repo.
10. **Ticker isolation, hidden-tab tween, preventScroll, section-key dedupe** — independent small patches (`DiffView.vue`, `useStackScroll.ts`, `ChangesView.vue`/`ExplorerView.vue`, `diffRows.ts`). All safe headless except the tween (needs a hide/refocus browser check).
11. **Long tail** — Explorer chunked highlight, AsyncFzf, splitter throttle, reconnect race. Any order.

## 5. Guardrails

- **"Observers never write layout" convention**: document in DiffStack (comment already drafted) and enforce with a lint rule — an ESLint `no-restricted-syntax` selector flagging `scrollTop`/`scrollTo`/`scrollIntoView` assignments/calls lexically inside `new ResizeObserver(...)` / `new IntersectionObserver(...)` callbacks in `packages/web`. Deleting `nudge()` removes the tempting API; the rule stops the next one.
- **Dev-mode RO loop detector**: a small wrapper around ResizeObserver in dev that counts callback deliveries per element per second and `console.error`s past a threshold (e.g. >20/s sustained) — would have named the freeze on day one.
- **Single-source height constants**: after fix 4, add a dev assert (extend `assertBodyHeights`) that the computed CSS var `--row-h` matches the probed rowH, so a future `--fs-base`/line-height edit can't silently reintroduce a second constant. The existing exact-height assert stays as the drift instrument; rate-limit its warning per key.
- **Key-stability assert**: in dev, after `buildDiffModel`, assert section keys and hunk keys are unique per model (throw in dev, no-op in prod) — catches the typechange-duplicate class and any future keyed v-for collision before Vue's patcher corrupts DOM.
- **Teleport rule**: never mount an enabled Teleport whose target lives inside the same Vue tree without `defer`; prefer out-of-tree targets in `index.html`. Add a short note in the web package docs and a portrait-mount smoke test (mount ExplorerView portrait without the manual slot helper — it should not warn or throw once `defer`/out-of-tree lands).
- **Budget tests**: unit tests asserting the huge-file gate counts a >1000-char single-line pair as gated (F3) and that the cumulative row budget caps `stackFiles` mounting (F5), so the bounds can't regress silently.
- **Single-flight audit**: store convention that every `refreshX` network pull carries an in-flight guard + rerun latch; a grep-level review checklist item until it's habitual.