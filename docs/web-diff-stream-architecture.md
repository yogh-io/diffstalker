# Web diff-stream: recommended architecture

## 1. Recommendation

Build an **eager-DOM stacked diff surface bounded by two-level `content-visibility`**, fed by a **hybrid bulk-then-incremental diff cache** in the repo store, with **manual scroll anchoring as the single compensation path** and **opacity-only, time-derived transitions** — zero new dependencies. This grafts the eager-render proposal's data model (whole-tree fetch up front, per-file refetch on SSE — the daemon confirmed stamps edit-times on whole-tree diffs), the lazy-mount proposal's anchoring sandwich and shared `DiffStack` component, and the virtual-scroller proposal's two killer insights (deterministic row heights make section sizes *exactly* computable, and raw-string identity preservation makes unchanged files zero-cost) — while rejecting windowed virtualization outright: it forfeits find-in-page and text selection, its blank-frame failure mode is structural, and GitHub itself only escalates to it beyond ~10k lines, a scale we cap with auto-collapse instead. Every judged break attempt against the three proposals is closed by construction here (section 6). The one non-negotiable prerequisite is making `diffRows.ts` keys content-stable — everything else is blocked on it.

## 2. Data model

**`packages/web/src/utils/diffRows.ts` — stable keys (prerequisite, phase 0).** Today `buildDiffModel` uses a per-build counter (`let key = 0` at line 254), so every rebuild renumbers everything and Vue tears down the whole DOM per update. Change to content-stable keys: section key = `${staged?'s':'u'}:${filePath}`; hunk key = `hash(sectionKey, hunkHeaderContext, oldStart)` with ordinal disambiguation on collision; row key = `${hunkKey}:${oldLineNum ?? '+'+newLineNum}`. Pure util change; History/Compare consumers unaffected except they stop churning DOM.

**`packages/web/src/stores/repo.ts` — per-file diff map replacing the selection-diff slot for Changes:**

```ts
const workingDiffs = shallowRef<{
  byKey: Map<string, { raw: string; diff: DiffResult /* markRaw */; fetchedAt: number }>;
  seq: number;
}>();
```

Key = rowKey (`s:` / `u:` + path), mirroring the file list exactly (a file both staged and modified gets two entries, two sections — same as today's list rows). `markRaw` every `DiffResult` — deep-proxying thousands of line objects would dominate reactivity cost.

**Fetch strategy — hybrid:**

- **Initial load / view activation:** two requests — `GET /diff` (whole-tree unstaged) and `GET /diff?staged=true` — split client-side into per-file `DiffResult`s by a new pure util `splitDiffByFile` (reusing the `diff --git` section grouping `buildDiffModel` already parses). Untracked files aren't in `git diff`: fetch per-file (`GET /diff?path=…`) through a concurrency-6 queue; they render sized placeholders meanwhile.
- **Steady state (SSE `state-change` in `applyWireState`):** compute the changed set by diffing new `mtimes`/`hunkCounts`/`status.files` against the previous snapshot; refetch **only those files** per-file. One save → one request → one map entry replaced. If the changed set exceeds ~15 files (branch switch), fall back to one whole-tree re-pull. Keep the existing 20ms debounce and generation guard verbatim; add a per-file in-flight seq so stale responses never land.
- **Stale-while-revalidate:** never blank an entry on refetch; replace in place when the new diff arrives. Files leaving the status set are evicted; entering files are fetched.

**Identity preservation (the zero-patch guarantee):** on every pull — including the whole-tree fallback — compare each file's new `raw` string by **value** against the cached one; if equal, keep the **same object**. A `WeakMap<DiffResult, DiffModel>` memoizes `buildDiffModel`, so unchanged files re-run nothing, keep the same vnodes, and produce zero DOM patches.

`selection.file` survives as the *active* file (nav highlight, auto-mode target) but no longer drives a fetch; the Changes branch of `doFetchDiffForFile`/`scheduleDiffFetch` is deleted (History's commit-diff path untouched — no dead architecture). No daemon changes required.

## 3. Rendering + virtualization

New shared component **`packages/web/src/components/DiffStack.vue`**, extracted from CompareView's diffs column (sticky per-file header, collapse chevron, stats, inner DiffView):

```
div.stack-scroller            (the ONE scroller; overflow-anchor: none)
  section.file-diff           (per file, keyed by rowKey, ALWAYS mounted)
    header.file-diff-header   (sticky; letter/path/stats/collapse)
    div.file-diff-body        (content-visibility: auto;
                               contain-intrinsic-size: var(--h-exact))
      DiffView rows           (existing row-level content-visibility kept)
    — or .placeholder         (untracked file whose fetch hasn't landed;
                               height from status insertions+deletions)
```

- **Eager DOM, no IntersectionObserver, no windowing.** All sections mount from the start; off-screen cost is bounded by the two c-v layers: a file 5000px away skips layout as one unit without iterating its rows; rows inside the realized file keep their own per-row c-v. Find-in-page, text selection, and the a11y tree keep working. `content-visibility` goes on the **body wrapper**, never the section — c-v on the section would break the sticky header inside it.
- **Exact intrinsic sizes, not estimates.** Rows are `white-space: pre` (no wrap), so heights are deterministic: `--h-exact = rows × rowH + hunks × hunkHeaderH` from ~4 constants probed once from a hidden sample (re-probed on a ResizeObserver on the probe, covering zoom/font changes). Deliberately **no `auto` keyword** — the browser's remembered size would go stale when a skipped subtree is patched (judge break #3); the computed value updates in the same Vue patch as the content, so the anchoring sandwich (section 6) compensates it, and later c-v realization is a no-op because estimate == real. Guard: a dev-mode assert comparing a realized body's `offsetHeight` to its computed height (1px tolerance).
- **Worst-case cap:** files over ~1500 changed lines auto-collapse behind a "Load diff" header (GitHub's escape hatch). Total DOM at 100 files / 10k lines ≈ 100–130k nodes — fine when only ~60 rows lay out/paint.
- **Compare reuse:** CompareView migrates onto `DiffStack` (its `compareDiff.files` already match the props shape, diffs pre-embedded so the placeholder path never triggers). It gains smooth jumps, scroll-spy, and the sticky-offset fix for its current `scrollIntoView`-under-sticky-header bug, and deletes its bespoke stacked markup.

`DiffStack` exposes `scrollToFile(key, opts)` / `scrollToHunk(key, i)` and emits `active-file`.

## 4. File list as jump navigator + scroll-spy

- **Jump:** clicking a list row calls `scrollToFile(rowKey, { smooth: true })`. Target top = cached `offsetTop` of the section minus the sticky-header offset, via `scroller.scrollTo` — never `scrollIntoView` (it scrolls all ancestors and ignores sticky headers). The active key is set **optimistically on click**.
- **Scroll-spy: not IntersectionObserver.** IO thresholds are meaningless for a 6000px section (ratio ~0 forever) and sticky headers skew its geometry. Instead: a passive, rAF-throttled scroll listener binary-searches a cached `offsetTop[]` (≤ file-count entries) for the section spanning `scrollTop + stickyOffset + 1px`, with hysteresis. The cache is invalidated by one ResizeObserver on the stack container. Exact, O(log n), ~free per scroll event.
- The spy writes `activeStackKey` (ui store); the list styles it with today's `.selected`, keeps `role=listbox`, roving tabindex, and `aria-selected`. ArrowUp/Down move the active key and trigger the same jump; Enter focuses the section (`tabindex="-1"`, `focus({ preventScroll: true })`); portrait flow via `usePortraitKeys` unchanged. The list auto-scrolls its active row into view (`block: 'nearest'`), suppressed while the pointer is inside the list.
- Spy emission is suppressed during programmatic scrolls until the tween completes, so the highlight doesn't strobe through intermediate files.

## 5. Smooth scroll, auto mode, reduced motion

One primitive, a **~30-line custom rAF tween** in `composables/useStackScroll.ts`, not native `behavior: 'smooth'`:

- Native smooth has no reliable completion signal (Safari has no `scrollend`) and never retargets when layout changes mid-flight. The tween eases `scrollTop` toward a target **re-read from the offset cache every frame**, so an SSE update landing mid-glide self-corrects — no land-measure-correct loop needed.
- Duration `clamp(200ms, distance-scaled, 450ms)`; jumps beyond ~3 viewports snap instantly to ~1.5 viewports short, then tween the rest (bounds animation time and realization churn).
- Cancelled instantly by any user wheel/touch/keydown on the scroller — never fight the user.
- `prefers-reduced-motion: reduce` (existing `useMediaQuery` composable): the tween degrades to one instant `scrollTop` assignment; all CSS transitions get the repo's existing static-highlight fallback. Never set CSS `scroll-behavior: smooth` on the scroller — it would animate the anchoring compensation writes.

**Auto mode (`composables/useAutoMode.ts`):** `selectNewestFile` keeps `repo.selectFile(entry)` (now just active-file) + `ui.flashFile(path)` (list-row flash unchanged), and adds `scrollToFile(rowKey(entry), { smooth: !reducedMotion })` — ideally `scrollToHunk` at the freshest `editedAt`. The in-diff hunk flash needs no new code: the refetched diff carries fresh `editedAt` and DiffView's `isFresh` overlay fires. Guard: if the user scrolled manually within the last ~1.5s, defer the auto jump.

## 6. Flicker-free transitions + scroll anchoring (R3)

Five cooperating mechanisms, one compensation path.

**(1) Content-stable keys** (section 2). With stable keys a refetch patches in place: unchanged rows keep their DOM nodes untouched; changed rows update text content only. Without this there is no transition, no surviving anchor node, no working c-v — it is the prerequisite.

**(2) Identity preservation** (section 2). An SSE burst touching file X rebuilds only file X's model; the other N−1 sections are referentially identical and Vue skips them entirely. No-op updates produce no patches, hence no flicker, by construction.

**(3) The anchor sandwich — one code path, all browsers.** Native scroll anchoring is out: Safari stable has none, sticky positioning and transforms suppress it, and it would double-correct against us. So `overflow-anchor: none` on the scroller, and around **every** `workingDiffs` commit:

1. **Pre-flush** (`watch(workingDiffs, …, { flush: 'pre' })`, DOM still old): pick the anchor — the topmost hunk header (or file header) at the viewport top whose stable key survives into the new model; record its `getBoundingClientRect().top`. Fallback ladder if the anchor itself is removed: nearest surviving hunk key above → its file header → nearest neighbor section by cached offset. Worst case is off by one header, never a screenful.
2. Vue patches.
3. **Post-flush** (`flush: 'post'` watcher — after the DOM mutation, in the same task, **before the browser paints**): re-find the anchor by key, re-measure its `top`, `scrollTop += newTop − oldTop`, instant write. Measured and corrected inside one frame ⇒ zero visible movement regardless of how much content above the viewport grew or shrank. No rAF — rAF would paint the uncorrected frame first; that *is* the flicker.
4. Skip compensation when all changes are below the viewport (height changes below the fold never move it).
5. If the tween is in flight, don't write `scrollTop` — the tween re-reads its target per frame and absorbs the shift itself.

**(4) Exact intrinsic sizes close the out-of-flush holes.** The two judged breaks that survived proposal review were DOM height changes happening *outside* Vue's flush:

- *Leave-animation removals* (break #1): **eliminated by policy — no leave animations, period.** Removed hunks/files vanish inside the Vue patch itself (where the sandwich sees them). The research is right that animating the exit of stale diff content keeps wrong data on screen; for a live tracker, instant drop is also the correct product behavior. No `<TransitionGroup>` anywhere below file granularity — nothing ever removes DOM on `transitionend`.
- *Deferred c-v realization shift* (break #3): a skipped section patched while off-screen would, with `contain-intrinsic-size: auto`, keep its stale remembered height until the user scrolls back and it realizes — an uncompensated jump minutes later. **Closed** by using pure computed `contain-intrinsic-size` (no `auto`): the placeholder height changes in the same flush as the content, the sandwich compensates it, and realization later is a ~0px delta because rows are `white-space: pre` and the computation is exact. Safety net: one ResizeObserver over section bodies compensates `scrollTop` (only `scrollTop` — RO callbacks run post-layout pre-paint) for any residual delta on a body entirely above the viewport, and screams in dev mode, since a nonzero delta means the deterministic-height assumption drifted.
- *Windowed blank frame* (break #2): structurally impossible — no windowing; the DOM under the corrected `scrollTop` is always fully present.

**(5) Layout-neutral transitions only.** Heights never animate — animated heights above the viewport would demand per-frame compensation (jitter) and made proposal 3's above/below policy necessary; we don't buy that. Policy:

- **Update:** the existing `editedAt`-driven `.flash` overlay (opacity-only, `pointer-events: none`, compositor-only). Unchanged.
- **Enter** (new hunk or file): appears at final height instantly (sandwich absorbs the layout delta) and announces itself with a ~300ms opacity fade-in layered on the flash overlay, driven by a time-derived `enteredAt` on the model — **not** element lifecycle — so a hunk scrolled out and back mid-window resumes correctly, exactly like `isFresh`.
- **Exit:** instant, compensated. No ghosts in v1.
- Reduced motion: static highlight, the existing house pattern.

## 7. Performance budget + measurement

| Metric | Bound | Budget |
|---|---|---|
| SSE update, 1 file changed of 100 (fetch response → parse → patch → anchor restore) | memo hit for 99 | < 16ms scripting |
| Whole-tree fallback re-pull, 100 files | value-equal files reuse objects | < 120ms, off interaction path |
| Layout shifts inside the scroller under churn | sandwich | **0** (`layout-shift` entries with `hadRecentInput: false`) |
| Scroll frame (spy + c-v realization) | binary search + realized band | 60fps sustained, < 4ms script/frame |
| Initial render, 100 files / 10k lines | eager DOM + c-v | < 300ms to first full paint |
| Jump-to-file landing error | exact offsets | 0px (no settle-correct pass needed) |

Measurement: `performance.mark/measure` around the commit → post-flush-restore path with a dev-overlay "anchor delta must read 0px" assertion; a `PerformanceObserver` on `layout-shift` and `long-animation-frame` in dev; Vue `onRenderTriggered` in dev to prove untouched sections never re-render; the dev height-assert from section 3. Regression harness: a script-generated fixture repo (100 files × 100–300 lines) with a churn loop touching files on a timer against the real daemon (tmux + `curl --unix-socket`, per CLAUDE.md), while the layout-shift observer must stay silent. This doubles as the R3 soak test.

## 8. Migration plan

Phases land green independently; A/B/C are parallelizable.

**Phase 0A — stable keys** (independent; unblocks everything)
- `packages/web/src/utils/diffRows.ts`: replace the sequential `nextKey` (line 254) with content-stable section/hunk/row keys as in section 2.
- `packages/web/src/utils/diffRows.test.ts`: key-stability tests (same content → same keys across builds; edited hunk → same hunk key, changed row keys only).

**Phase 0B — store data model** (parallel with 0A)
- `packages/web/src/utils/splitDiffByFile.ts` (new pure util) + tests.
- `packages/web/src/stores/repo.ts`: add `workingDiffs`, hybrid fetch (`refreshAllDiffs`, per-file refetch on `applyWireState` via mtimes/hunkCounts/status diffing, >15-file fallback, untracked queue), raw-string identity preservation, `WeakMap` model memo, per-file seq guards. Keep the old selection path alive this phase.
- `packages/web/src/stores/repo.test.ts`: identity preservation, changed-set computation, fallback threshold, stale-response guards.

**Phase 0C — DiffStack extraction** (parallel; pure refactor, no behavior change)
- `packages/web/src/components/DiffStack.vue` (new): extracted from CompareView's diff column; props `files: StackFile[]`; sticky headers, collapse, placeholder branch; exposes `scrollToFile`/`scrollToHunk` (instant only for now), emits `active-file`.
- `packages/web/src/views/CompareView.vue`: migrate onto it; fix the sticky-offset jump bug in passing. Tests updated.

**Phase 1 — Changes on the stack**
- `packages/web/src/views/ChangesView.vue`: right pane becomes `DiffStack` fed from `workingDiffs` in `categorizeFiles` order; file list becomes the jump navigator; delete the single-DiffView selection path and the Changes branch of the store's selection-diff fetch (same commit — no parallel legacy path).
- `packages/web/src/composables/useStackScroll.ts` (new): offset cache + container ResizeObserver, binary-search scroll-spy with suppression, the rAF tween with per-frame retarget, reduced-motion degrade, long-jump snap. Unit-test the tween and spy math.
- `packages/web/src/stores/ui.ts`: `activeStackKey`.

**Phase 2 — anchoring (the R3 core)**
- `packages/web/src/composables/useScrollAnchor.ts` (new, ~60 lines): the pre-flush/post-flush sandwich + fallback ladder + tween handoff; wired inside `DiffStack`; `overflow-anchor: none` on the scroller.
- `DiffStack.vue`: computed `contain-intrinsic-size` from probed constants (probe element + ResizeObserver re-probe); dev height-assert; RO safety-net compensator.
- `scripts/` (or `packages/web/dev/`): the churn fixture + layout-shift harness. Soak here before phase 3.

**Phase 3 — transitions + auto mode**
- `packages/web/src/components/DiffView.vue` / `DiffStack.vue`: `enteredAt` fade-in layered on the flash overlay; reduced-motion fallbacks.
- `packages/web/src/composables/useAutoMode.ts`: add the smooth jump + user-scroll deferral.
- Auto-collapse cap (~1500 lines) behind a "Load diff" header.

**Phase 4 — hardening**
- Budget verification against the fixture; Safari/Firefox manual pass (c-v realization, find-in-page); `onRenderTriggered` audit; delete any remaining dead selection-diff code.

## 9. Risks + what to prototype first

1. **The anchor sandwich is the load-bearing trick** and coordinates SSE patches, c-v realization, and an in-flight tween; ordering bugs show as rare one-frame hops findable only under instrumented soak. **Prototype first:** a minimal `DiffStack` + `useScrollAnchor` + the churn fixture with the layout-shift observer, before any view migration. If the sandwich can't hold 0 shifts under churn in isolation, nothing downstream matters.
2. **Deterministic heights are a single point of failure** for the exact `contain-intrinsic-size` approach — any future wrapping CSS or sub-pixel line-height drift becomes silent offset bugs. **Prototype second:** the probe-constants + computed-intrinsic-size approach on one large diff across Chrome/Firefox/Safari 18, verifying realized `offsetHeight` == computed within 1px at several zoom levels. If it drifts, the fallback is `contain-intrinsic-size: auto var(--h-exact)` plus promoting the RO compensator from safety net to primary — a contained change inside `DiffStack`.
3. Lesser risks: hunk-key hashing misreading a shifted hunk as remove+add (worst case a spurious fade, never a shift); many-untracked-files fetch queues (placeholders mask, don't remove); whole-tree fallback long task at branch-switch scale (bounded by the memo; measure in phase 4). Zero new dependencies — every requirement maps to a native primitive, so there is no library risk to carry.