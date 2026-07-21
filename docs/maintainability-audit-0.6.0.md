# Maintainability Audit — diffstalker (post-0.6.0)

## 1. Summary

The daemon split landed cleanly: architecture layering is enforced by dependency-cruiser, the CLI is a pure daemon client, `any` is absent from web/daemon/client production code, and the tarball allowlists keep dead tsc output out of published packages. The debt clusters in three predictable post-migration places. First, **the docs drifted** — the root README describes the new web UI as a full read/write client when it shipped read-only, which is the single most misleading fact in the repo. Second, **the web frontend duplicates the CLI and client by hand** — all six theme tables, the entire daemon client method surface, diff-parsing primitives, and the diff-row model are forked copies kept in sync by comments, not code. Third, **the newest code is the least tested** — the web diff-row model (303 lines) and several substantive components/composables have no unit tests. None of this is a live bug; it is classic "two copies drift apart" and "stale prose" debt, plus a handful of complexity hotspots carried over unchanged. Health is good; the work is consolidation and test backfill, not firefighting.

## 2. Quick wins

Safe, mechanical, low-effort. Do these now.

- [ ] **README web UI section** (`README.md:44,188-201`) — rewrite to describe a read-only viewer; link to `FEATURES.md:656-702` instead of re-listing. Highest-impact fix: the README currently claims "full feature parity" (staging, commit, cherry-pick, remote ops) that does not exist.
- [ ] **README security note** (`README.md:203`) — the daemon defaults to an owner-only unix socket, not `127.0.0.1`; it binds TCP only with `--port`. Reword to match `packages/daemon/README.md:54-66`.
- [ ] **package.json inlined into CLI bundle** (`packages/cli/src/ui/modals/HotkeysModal.ts:4`) — switch to `import { version } from '../../../package.json' with { type: 'json' }` so bun tree-shakes to just the version string instead of inlining the whole dev manifest.
- [ ] **Stale package-count refs** (`eslint.metrics.js:6`, `CLAUDE.md`) — "the four packages" is now five; make count-agnostic and refresh the warning-count note to mention web.
- [ ] **Metrics collector skips .vue** (`scripts/collect-metrics.ts:87`) — add `.vue` to the extension filter so web's SFC lines are counted in the per-release snapshot.
- [ ] **pre-push hook hard-requires `act`** (`.githooks/pre-push:14`) — guard with `command -v act >/dev/null || exit 0`, and note act/Docker as a release prerequisite in CLAUDE.md.
- [ ] **web workspace dep classification** (`packages/web/package.json:23,30`) — core is a dep, client is a devDep; pick one convention (web is never published).
- [ ] **Dead functions kept alive by their own tests** (`packages/core/src/git/diff.ts:119` getStagedDiff, `packages/cli/src/utils/syntaxHighlight.ts:54` highlightBlock, `packages/cli/src/utils/ansiTruncate.ts:115` needsTruncation, `packages/core/src/view/fileCategories.ts:35` getFileListSectionCounts, `packages/cli/src/utils/displayRows.ts:477` getWrappedRowCount) — delete each plus its test block.
- [ ] **diffRowCalculations dead cluster** (`packages/core/src/view/diffRowCalculations.ts`) — delete getLineNumWidth, getDiffLineWidth, getDiffLineRowCount, getDiffTotalRows (~110 LOC); keep getLineContent. Do this together with the duplication extraction in §3 (same file).
- [ ] **CompareView non-null assertions** (`packages/web/src/views/CompareView.vue:374-404`) — resolve the file once per row (`const f = files[row.fileIndex]`, skip if absent), removing ~11 `!` assertions.
- [ ] **useRepoOpen composable test** (`packages/web/src/composables/useRepoOpen.ts`) — small, high-value: assert a refused open leaves `trackActive` uncalled and adds no recent; guards a stated desync invariant.

## 3. Worth doing

Needs judgment or more effort. Grouped by area, ordered by impact within each.

### Duplication (the main structural debt)

- **Six theme tables forked CLI↔web** (`packages/cli/src/themes.ts`, `packages/web/src/theme/themes.ts`) — **M**. Byte-for-byte duplicate color data synced by a comment. Move the framework-neutral part (ThemeName, DiffColors, per-theme colors, themeOrder, getTheme/isThemeName) into `@diffstalker/core/view/themes.ts` (pure, browser-safe); web keeps its chrome/syntax extensions local and merges. Highest-value dedup — pure data, safe-mechanical.
- **Diff-parsing primitives duplicated 2-3x** (`diffRowCalculations.ts`, `cli/.../displayRows.ts`, `web/.../diffRows.ts`) — **M**. The @@-header regex, git-header path extractor, and line-num-width formula are re-derived in all three. Export `parseHunkHeader`, `extractDiffFilePath`, and the existing width helper from the already-browser-safe core module; the CLI's reduced sort-key regex at `displayRows.ts:518` can read the start fields from the same parser. Pair with the dead-code deletion in the same file.
- **Web reimplements the whole daemon client** (`packages/web/src/api/client.ts` vs `packages/client/src/client.ts`) — **L**. Method-for-method fork, with reviveCommit/toQuery/repoPath/errorMessage duplicated verbatim. The transport split is legitimate (client hard-wires a Node-only Transport). Parameterize `@diffstalker/client`'s DiffstalkerClient over a minimal `{request, openSse}` interface and inject web's fetch/EventSource transport. If the full refactor is too big now, at least hoist the four verbatim helpers into a shared module.
- **Word-diff run-pairing reimplemented** (`cli/.../displayRows.ts:122` vs `web/.../diffRows.ts:167`) — **M**. Same algorithm; the builders legitimately diverge *after* pairing. Extract `pairChangeRuns(deletions, additions, getContent)` into a core view helper, keep the distinct downstream row shapes.
- **FileStatus→letter map duplicated** (`web/.../format.ts:19`, `cli/.../fileRowFormatters.ts:4`) — **S**. Add `statusLetter(status)` to core/view; keep CLI's blessed-tag coloring local.

### Docs

- **Doc-fact duplication is the drift mechanism** (`README.md`, `FEATURES.md`, `packages/daemon/README.md`, `CLAUDE.md`) — **M**. Web-serving, CORS, security, and follow-path facts are restated in four files; the security copy has already drifted (§2). Designate one owner per fact (daemon README for transport/CORS/security/follow-file; FEATURES.md for the web capability list) and link rather than restate.
- **web-frontend-spec shipped-vs-pending note** (`docs/web-frontend-spec.md:5`) — **S**. The phasing is already correct; just add a short dated note that Phase 5a (read-only) shipped in 0.6.0 and mutation phases have not, so the present-tense "mirrors every CLI feature" at line 5 isn't read as current behavior.

### Dead code / API surface

- **~40 self-only-referenced exported types** (`KeyBindings.ts:12`, `RepoSession.ts:69`, `router.ts:26`, etc.) — **M**. The ctx/options/callbacks interfaces the split created are exported with no consumer. Drop `export` on app-internal CLI/daemon context types used only in their own file; leave genuine public exports alone. Add a knip or eslint no-unused-modules pass to stop recurrence. (Count is an estimate; 13 sampled all held.)

### Types

- **Wire contract hand-mirrored daemon↔client** (`daemon/src/serialize.ts:14,19` vs `client/src/wire.ts:42,52`) — **M**. WireSharedState/WireHunkCounts declared twice with a "keep in sync" comment; the mtimes doc comments already differ. Extract into a type-only module both import (e.g. `@diffstalker/core/types`) — types erase at build, so the client's node-only runtime constraint is preserved.
- **One SSE-snapshot shape guard** (`packages/web/src/api/client.ts:180`, `packages/client/src/client.ts:106`) — **M**. Keep the trusted-wire `as T` design for per-request calls, but add one `isWireSharedState` guard at the highest-fan-out SSE boundary that routes a shape mismatch into the existing connection-loss path instead of letting a skewed payload blow up deep in render.

### Complexity hotspots

- **getCompareDiffWithUncommitted, CC-41** (`packages/core/src/git/diff.ts:376`) — **M**. Worst hotspot. Extract parseNumstat (collapses two duplicated loops), buildStatusMap, splitUncommittedFileDiffs, mergeCommittedWithUncommitted; top function becomes ~6 testable calls, drops under CC 15.
- **buildRawDiffRows, CC-39** (`packages/cli/src/utils/displayRows.ts:146`) — **M**. Keep the while-driver, extract handleHeaderLine/handleContextLine/consumeDelAddBlock over a mutable ctx; collapse the two near-identical del/add push-loops into one `pushDiffRows`.

### Tooling

- **Arch PKGBUILD omits web assets** (`PKGBUILD:59`) — **S**, but real prod/prod divergence: the AUR daemon serves API-only because `dist/web` is never copied. Add `cp -r packages/daemon/dist/web` into `package()` so the layout matches `resolveWebRoot`.
- **ESLint config duplicated across 5 packages** (`packages/*/eslint.config.js`) — **M**. core/cli are byte-identical. Extract a root `eslint.config.base.js`; each package spreads it and adds only deltas (daemon: todo-tag off; web: vue + browser globals).
- **Root scripts are brittle cd-chains** (`package.json:16,19,21,23,24,25`) — **M**. Replace with `bun run --filter='*' <script>`; drop the redundant second client build (cli's tsc references already build core+client) and make web a first-class build target instead of a daemon build:web side effect.
- **dependency-cruiser options/no-circular duplicated in 5 configs** — **M**. Factor the shared options tail and no-circular rule into a root `.dependency-cruiser.base.cjs`; keep per-package layering rules inline.

### Tests

- **Web diffRows.ts has no unit test** (`packages/web/src/utils/diffRows.ts`) — **M**. 303 lines of the exact "single source of truth for rows" logic CLAUDE.md warns about; only exercised as a DOM black box. Add `diffRows.test.ts` driving DiffLine[] fixtures (multi-file grouping, per-file hunk ordinals, run pairing similar/dissimilar, binary detection, totalRows aggregation), mirroring the CLI's `displayRows.test.ts`.
- **Node client SSE frame parser untested** (`packages/client/src/transport.ts` feed()) — **M**. Only clean-frame integration covers it. Unit-test the split-across-chunks, two-frames-in-one-chunk, ping-comment, and close-mid-buffer paths. Assert onEvent fires once per logical frame and never after close.
- **Substantive web components untested** (`RepoOpenForm.vue`, `RepoSwitcher.vue` 206 lines, `FileContentPane.vue` 318 lines) — **M**. 7 of 11 components have no test. Prioritize RepoOpenForm (openError-vs-live-error branch, disabled/busy submit) and the two largest; treat StatusBar/ThemeSwitcher/RepoEmptyState/HotkeysOverlay as lower priority.
- **Client wire decoders untested** (`packages/client/src/client.ts`, `wire.ts`) — **S**. The encode side has serialize.test.ts; add a matching decode-side unit test over reviveCommit and the compare-diff mapping so wire drift fails locally, not only in integration.

## 4. Leave / risky

Do not rush these in the days after a release.

- **Full web-client refactor over a shared transport interface** (§3, `packages/web/src/api/client.ts`) — **L**, needs-judgment. Touches every read path in the web SPA, which has thin test coverage (§3 tests). Land the web diffRows and component tests *first*, then do this behind that safety net. Hoisting the four verbatim helpers is the safe partial step to take now.
- **RepoSession debounce/stale-guard tests use real-timer sleeps** (`packages/cli/src/daemon/RepoSession.test.ts`) — the logic is well designed; only the harness is brittle around the 20ms window. Move to fake timers when the file is next touched. Not worth a dedicated change now.
- **reviveCommit Invalid Date on malformed wire date** (`packages/web/src/api/client.ts:40`) — theoretical under lockstep (daemon emits valid ISO). Either add a `Number.isNaN(d.getTime())` check or a one-line comment; lowest priority.
- **Mid-tier complexity cluster (16 functions CC 16-26)** — accepted baseline, mostly render/format switch-heavy code where splitting hurts readability. Do *not* run a refactor campaign; instead ratchet CI to fail if the warning count climbs above 18. Opportunistic wins only if the files are touched anyway (`config.ts:42`, `status.ts:94`).
- **build:prod --external drift** (`packages/cli/package.json`, `packages/daemon/package.json`) — the daemon list exactly equals its deps and is the clean candidate to auto-derive; the CLI list is deps-minus-diffstalker-binary (spawned, not imported), so a naive `--packages external` needs the noted care. Low urgency; do with the tooling cleanup, not standalone.

**Verified-resolved (no action):** no dead tsc modules ship in tarballs (narrow `files` allowlists); all 7 eslint-disables are justified and there is zero `any` in web/daemon/client production code.