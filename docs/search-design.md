# Search design

One decision document for search in diffstalker. Written 2026-08-05, against
`docs/feature-review-0.9.0.md`, which is still a standing stop-sign.

Read `docs/feature-review-0.9.0.md` first. This document extends it: section 7
below records the search-shaped things that were considered and rejected, so the
same ground does not get re-covered a third time.

---

## 1. Is the "trifecta" the core set?

**No.** Global text search + file search + in-file method search is VS Code's
search menu, not a decomposition of this product. It scores 1 out of 3, and the
one hit is already built.

Checked against the code:

- **Leg 2, fuzzy file-by-name: already ships, in both UIs.** `GET
  /repos/:id/files` (`packages/daemon/src/routes/explorer.ts:103`) serves
  `listAllFiles` (`packages/core/src/git/status.ts:563` — `git ls-files -z
  --cached --others --exclude-standard`). The web matches it with fzf in
  `packages/web/src/components/FinderOverlay.vue:89`, the CLI in
  `packages/cli/src/ui/modals/FileFinder.ts:58`. Both use `casing: 'smart-case'`
  and both reveal in the Explorer on activate.
- **Leg 3, in-file symbol search: no substrate exists.** The deepest code
  intelligence in five packages is `getLanguageFromPath`
  (`packages/core/src/view/languageDetection.ts:7`), an extension-to-hljs string
  map. Real symbols mean tree-sitter or ctags inside the published `diffstalkerd`
  tarball, plus an index, a cache and an invalidation story. The diff-shaped
  version of the question — "which function does this hunk touch?" — is already
  answered for free by git's own hunk header.
- **Leg 1, repo-wide content grep: wrong corpus, worst bill on the list.** It
  needs a new endpoint walking arbitrary repo content on the browser-reachable
  `web` API surface (GETs are exempt from the CSRF guard,
  `packages/daemon/src/security.ts:154`), built on a git client with no timeout
  and no maxBuffer (`packages/core/src/git/gitClient.ts:38`), over `git grep`
  output that is not UTF-8-safe. And it answers a question about the tree at
  rest, which the editor already open behind the window answers better.

### The frame error

Editors search the tree at rest. diffstalker's subject is **the change** —
README line one: "A live, always-on view of everything changing in your git
repos". The trifecta varies *scope* while pinning *corpus* (worktree content) and
*state* (worktree, not index/HEAD/compare base). It also contains three
locate-and-jump gestures and zero narrow gestures, which is the wrong weighting
for a viewer.

### The real core set for this product

Four gestures, in order of how much they belong here:

1. **Locate a file by name.** Shipped. Ctrl+P / `/`, fzf over the path list.
2. **Narrow a live list in place.** The changed-file set, the Compare tree, the
   commit list. This is the verb the trifecta has no word for, and it is the one
   thing genuinely missing. `docs/feature-review-0.9.0.md:104` already parked it
   ("filtering or sorting the changed-file set") and §6 names the trigger.
3. **Reach diff content the DOM is withholding.** Native Ctrl+F already works —
   windowed virtualization was rejected precisely to keep it working
   (`docs/web-diff-stream-architecture.md:5`, "rejecting windowed virtualization
   outright: it forfeits find-in-page and text selection"). The only hole is
   files gated behind "Load diff" at over `HUGE_FILE_CHANGED_LINES = 1500`
   changed lines (`packages/web/src/components/DiffStack.vue:148`). One button
   closes it. That is not a search feature.
4. **Orient inside one file's diff.** Which hunk is which. git's `@@` funcname is
   already parsed and already on screen.

Everything else on the trifecta's escalation path — workspace symbols,
find-references, pickaxe, replace, command palette, cross-repo — is rejected in
section 7.

### Corpus rule

**Every search surface reads state the client already holds.** The moment a
surface needs to walk arbitrary repo content, it has left this design and become
a code-search tool. There is no slot reserved for one.

---

## 2. Keybindings

### The three chords you remembered

All three are wrong, and two of them are wrong even as editor conventions.

- **Ctrl+H is not a search command anywhere.** In VS Code it is Replace (in-file);
  workspace replace is Ctrl+Shift+H. Chrome and Edge open History on it. Worse:
  **⌘+H on macOS is OS-level "Hide application" and cannot be intercepted at
  all**, so a Ctrl+H binding could never be mirrored and Mac users would get
  nothing. An asymmetric chord is worse than no chord. Reject.
- **Ctrl+P is right, and we already have it.** It is the de-facto standard for
  fuzzy open-file across VS Code, Sublime, Zed and Sourcegraph's web UI (JetBrains
  is the outlier at Ctrl+Shift+N; GitHub uses bare `t`). We bind it at
  `packages/web/src/composables/useGlobalKeys.ts:77-91`. Keep it exactly as is.
- **Ctrl+O is File > Open in VS Code**, not go-to-symbol. Symbol-in-file is
  Ctrl+Shift+O. Chrome, Firefox and Safari all use Ctrl+O for the file picker.
  Only Sourcegraph binds it to symbols, and symbols are rejected here anyway.
  Reject.

### Verified editor defaults

| Action | VS Code | JetBrains | Zed | Sublime | Helix | GitHub web |
|---|---|---|---|---|---|---|
| Find in files | Ctrl+Shift+F | Ctrl+Shift+F | ctrl-shift-f | Ctrl+Shift+F | Space `/` | `s` or `/` |
| Open file (fuzzy) | **Ctrl+P** | Ctrl+Shift+N | ctrl-p | **Ctrl+P** | Space `f` | `t` |
| Symbol in file | Ctrl+Shift+O | Ctrl+F12 | ctrl-shift-o | Ctrl+R | Space `s` | none found |
| Symbol in project | Ctrl+T | Ctrl+Alt+Shift+N | ctrl-t | — | Space `S` | — |

Telescope and fzf.vim ship no default keymaps at all; users bind them.

### What we bind

| Key | Action | Status |
|---|---|---|
| Ctrl/⌘+P | toggle the file finder | shipped, unchanged |
| Ctrl+F | browser find-in-page | **permanently the browser's** |
| Ctrl+Shift+F | — | **deliberately not taken** |
| Ctrl+H, Ctrl+O | — | rejected (above) |
| bare `e` | expand all gated diffs | new, §5.4 |
| bare `o` | hunk outline for the active file | new, §5.5 |
| bare `/` | narrow this list | new, §5.6, trigger-gated |

Rules that already govern the file and must govern anything new
(`useGlobalKeys.ts` header and body):

- A chord that must fire while typing goes **above** the `isEditable` guard at
  `useGlobalKeys.ts:102`. Bare keys go below it, and below the overlay gate at
  `:110`.
- `preventDefault()` only on the branch where the key actually acts. With no
  active repo, Ctrl+P leaves Print to the browser. Copy that.
- Do not take a chord that cannot be expressed identically on both platforms.

Bare `/` costs Firefox's quick-find-on-type, which is off by default and
cancelable. It buys the vi/less/GitHub gesture, and it reads as "narrow this
list", not "search the world". The CLI already binds `/` to the finder on the
Explorer tab only (`packages/cli/src/KeyBindings.ts:205-211`), so the shared
meaning holds: `/` searches the list you are looking at.

Do not build a shared vocabulary around chords. A terminal cannot express
Ctrl+Shift+letter at all; Ctrl+H is ambiguous with Backspace under `stty erase
^H`; Ctrl+I is Tab and Ctrl+[ is Esc. The CLI/web parity that survives a terminal
is bare-key parity, and that is the only kind to design for.

### Is configurability needed now?

**No, and building it would itself be the scope creep.**

The whole web keyset is roughly fifteen keys, all listed in
`HotkeysOverlay.vue`. A configurable keymap needs a schema, persistence, conflict
detection, a rebinding UI, per-platform normalization, and a CLI/web divergence a
terminal cannot close. There is no precedent to copy: `packages/cli/src/config.ts`
holds six flat scalars, each hand-validated; `packages/web/src/prefs.ts` holds
flat scalar fields validated one by one at `:133-134`. A keymap would be the
first nested, open-keyed, cross-platform structure either file has ever carried.

`docs/feature-review-0.9.0.md:114` already boundary-rejects a plugin system, and
the spec's only remaining keyboard item is shortcut *help*, not rebinding.
Revisit on the same trigger as everything else: one real external user reporting
an actual conflict outweighs all of this, because that is evidence and this is
inference.

---

## 3. UI placement — the chosen design

**Three placements, on three layers the app already has. No new layer, no new
view, no new overlay slot.**

The app has exactly two non-view UI layers today: modal overlays at z-index 100
(`packages/web/src/style.css:418-439`, `OverlayName = 'finder' | 'help'` at
`packages/web/src/stores/ui.ts:32`, and `App.vue:396-397` renders them
`v-if`/`v-else-if` so at most one is ever open), and non-modal dismissable
popovers at z-index 20 (`useDismissable`, used by the repo and worktree
switchers). Views own their own toolbars and headers, with a
`#view-toolbar-slot` teleport target for the narrow layout.

Search maps onto those three, one gesture each:

| Gesture | Layer | Entry | Persists? |
|---|---|---|---|
| Locate a file by name | modal overlay (z100) | Ctrl+P | no, transient |
| Narrow a live list | in-view header / toolbar slot | bare `/` | yes, as a chip |
| Orient inside a diff | dismissable popover (z20) | bare `o` or click | no |

### Why this shape and not the alternatives

Three shapes were designed and judged.

- **A scoped palette** (one overlay, three corpora) touches the least code and
  keeps every existing invariant. Its two weak points were typed scope prefixes
  (`+`, `#`) and a changed Ctrl+P close reflex. Both are removable, and removing
  them leaves this design.
- **A persistent shell dock** was rejected on placement. `.shell` is a
  single-column grid whose comment states the nav is a full-width band at every
  width so it never steals horizontal room from the diff; a permanent 26rem right
  column is exactly the pattern that grid excludes. It also invents a third UI
  layer between z100 and z20. Its two good ideas — the hunk outline and
  hunk-precision jumps — are grafted below.
- **A sixth "Find" rail view** was rejected on the URL. `useUrlSync.ts:1-5` says
  the URL "names ONE PLACE … Preferences, modes, expansion sets and scroll offsets
  are not places and never appear." A query is a filter over an existing set, not
  a place. `base` is in the URL because it changes *which commits exist*; a query
  changes *which subset is shown*. Without URL identity the sixth view loses its
  only argument. It also breaks persistence: `setActiveView` calls `savePrefs`
  on every call (`stores/ui.ts:92-93`) and `prefs.ts:134` restores it, so a cold
  tab would open into an empty Find view.

Grafted in from the losing designs: the hunk outline (whole), hunk-precision
jumps, honest-corpus copy on every surface, stable-id selection, and the
bounded-scan discipline.

### ASCII mock — wide / split layout, filter active

```
+================================================================================================+
| diffstalker   ~/gitRepos/diffstalker   main               follow on   a s d f       connected  |
+------------------------------------------------------------------------------------------------+
| 1 Changes | 2 Journal | 3 History | 4 Compare | 5 Explorer                                     |
+------------------------------------------------------------------------------------------------+
| [ / finder__________________ x ]  4 of 214 changed        esc clears                           |
+---------------------------------+--------------------------------------------------------------+
| MODIFIED                      3 | packages/web/src/components/FinderOverlay.vue     +48 -12    |
|  M web/../FinderOverlay.vue     |  [ 3 hunks v ]                                               |
|  M web/../useGlobalKeys.ts      |  @@ -62,15 +62,9 @@ updateResults                             |
| UNTRACKED                     1 |  -function updateResults(): void {                           |
|  ? core/../finderModel.ts       |  -  const all = paths.value ?? [];                           |
| STAGED                        0 |  +const index = createFinderIndex(paths, FINDER_LIMIT);      |
|                                 |                                                              |
|                                 | packages/web/src/composables/useGlobalKeys.ts      +9 -2     |
|                                 |  [ 2 hunks v ]                                               |
|                                 |  @@ -100,6 +100,11 @@ onKeydown                              |
|                                 |  +  if (event.key === '/') { filter.open(); return; }        |
+---------------------------------+--------------------------------------------------------------+
| 214 changed (4 shown)  +3120 -890     journal: 41 entries since 09:12            connected     |
+================================================================================================+

  The list AND the diff stack narrowed together: stackFiles derives from the
  same categories.ordered, so the filter is also the row-budget lever.
```

### ASCII mock — hunk outline (bare `o`, non-modal popover, z-index 20)

```
  packages/web/src/stores/repo.ts               +18 -4        [ 3 hunks v ]
                                                            +----------------------------------+
                                                            | filter hunks ___________________ |
                                                            |----------------------------------|
                                                            | +3 -0    924-932 -> 924-935      |
                                                            |          fetchWorkingDiffsFor 2m |
                                                            | +9 -2   1041-1049 -> 1044-1052   |
                                                            |          pruneWorkingDiffs       |
                                                            | +6 -2   1180-1188 -> 1183-1191   |
                                                            |          selectFile              |
                                                            +----------------------------------+
                                                              ranges, stats and the trailing @@
                                                              context all come straight off
                                                              DiffHunkGroup — no parser, no index
```

### ASCII mock — stacked / narrow (`:root[data-split="stacked"]`)

```
+--------------------------------------------------+
| diffstalker   main               a s d f         |
+--------------------------------------------------+
| 1 Chg | 2 Jrnl | 3 Hist | 4 Cmp | 5 Expl         |
+--------------------------------------------------+
| [ / finder_______________ x ]  4 of 214          |   <- teleported to #view-toolbar-slot
+--------------------------------------------------+
| M web/../FinderOverlay.vue                       |
| M web/../useGlobalKeys.ts                        |
| ? core/../finderModel.ts                         |
+============ SplitResizer (row axis) =============+
| packages/web/src/stores/ui.ts        +9 -1       |
|  [ 2 hunks v ]                                   |
|   159 + function requestStackScroll(key, hunk) { |
+--------------------------------------------------+
| 214 changed (4 shown)             connected      |
+--------------------------------------------------+

  The filter input teleports into #view-toolbar-slot with :disabled="!isPortrait",
  the pattern ExplorerView and CompareView already use for their own controls.
  No `/` on a touch keyboard — the header's filter button is the entry point.
```

---

## 4. What is being built now, and what is gated

| # | Item | State | Why |
|---|---|---|---|
| 5.1 | Shared finder model in `@diffstalker/core/view` | **build now** | dedupe of code already written twice |
| 5.2 | CLI: Ctrl+C dead in the finder | **build now** | defect in a shipped release |
| 5.3 | `/files` invalidation, both UIs | **build now** | defects in shipped code |
| 5.4 | Expand all gated diffs (`e`) | build next | restores native Ctrl+F reach |
| 5.5 | Hunk outline (`o`) | trigger-gated | cheapest new value, still new UI |
| 5.6 | Changed-set filter (`/` + chip) | trigger-gated | `feature-review-0.9.0.md:104` parked it |
| 7 | Everything else | **rejected** | see section 7 |

The trigger is `docs/feature-review-0.9.0.md:157` verbatim: a monorepo, a
several-hundred-file changeset, or heavy submodule use — or a real external user
asking. It has not fired.

---

## 5. Implementation, one section each

### 5.1 Shared finder model (build now)

The only genuinely duplicated logic. `FinderOverlay.vue:62-76,123-148` and
`FileFinder.ts:20-30,145-172,196-201` are the same code in two dialects.

**New file: `packages/core/src/view/finderModel.ts`** (plus `.test.ts`).

```ts
export const FINDER_DEBOUNCE_MS = 15;

export interface FinderMatch {
  text: string;
  /** Indices (into text) of the matched characters. */
  positions: Set<number>;
}

export interface Segment { text: string; hit: boolean }

/** Build a matcher over `items`. Empty query returns the first `limit` items. */
export function createFinderIndex(
  items: string[],
  limit: number
): { find(query: string): FinderMatch[] };

/** Fold matched indices into runs. `sliceFrom` re-aligns for a truncated string. */
export function toSegments(text: string, positions: Set<number>, sliceFrom?: number): Segment[];

export function clampMove(index: number, delta: number, length: number): number;
export function cycleMove(index: number, delta: number, length: number): number;
```

**Decisions.**

- **Synchronous only.** Three drafts proposed three signatures; one of them was
  promise-shaped because it picked `AsyncFzf` above a size threshold. Rejected.
  Nobody has the repo that needs it, and making `find` async imports an
  out-of-order-resolve bug class into two call sites that currently have none. If
  the monorepo trigger fires, that is a separate decision.
- **No state in the model.** No `selectedIndex`, no `appliedQuery`, no factory
  that returns a state object. The CLI keeps its instance fields, the web keeps
  its refs. The shared part is the pure part. Two of the three drafts proposed a
  stateful model with three different constructors for the same state; that is
  more surface than it deletes.
- **`sliceFrom` is the CLI truncation fix.** It removes the `offset = offset - 1`
  re-alignment at `FileFinder.ts:196-201`.
- **fzf stays in `packages/cli/package.json:62` and `packages/web/package.json:25`.**
  Do **not** remove it from either, and do not touch the `--external fzf` in
  `packages/cli/package.json:33`. `@diffstalker/core` is private and pinned at
  `0.0.0`; its `dependencies` are never installed by anyone. Removing `fzf` from
  the CLI manifest would leave an unresolvable bare import in the published
  tarball, caught only by CI's tarball boot after the release pipeline has
  started. Add `fzf` to core's `dependencies` for workspace type resolution
  honesty and change nothing else.
- **No `daemon-no-fzf` dependency-cruiser rule.** It cannot fire (per-package
  configs see `@diffstalker/*` as unresolved externals) and its premise is false
  (`packages/daemon/package.json` ships `dist/web`, which already contains
  vite-bundled fzf).

**Caps.** `limit` is passed in: 50 in the web (`FinderOverlay.vue:25`), and the
CLI's 15 stays 15 for now. Changing the CLI's cap means building a scrolling
viewport, which is CLI feature work in a package the project has demoted. Not
part of this.

**Security.** None. Pure functions, no I/O, no git, no path handling. One
pre-existing hole is worth closing in the same touch: `FileFinder`'s box is
`tags: true` (`FileFinder.ts:73`) and highlight text is concatenated into blessed
markup unescaped, so a repo file literally named `a{bold}b` corrupts the modal.
Run each segment through `blessed.escape()` in the emit step.

**Tests.** `packages/core/src/view/finderModel.test.ts`: empty query returns the
first `limit` items in input order; smart-case both directions; `toSegments`
coalesces runs; non-adjacent positions stay separate; `sliceFrom` shifts and
drops out-of-range positions; unsorted position iterables give the same result as
sorted (both current call sites test `positions.has(i)` and are order-independent
— a shared implementation must normalize); `clampMove` stops at both ends;
`cycleMove` wraps both ways. `FinderOverlay.test.ts` must pass **untouched**,
including the single-fetch assertion.

**Effort.** Half a day. Net negative line count. No new key, no new endpoint, no
new dependency edge.

### 5.2 CLI: Ctrl+C is dead in the finder (build now, separate commit)

`screen.key(['C-c'], …)` at `packages/cli/src/KeyBindings.ts:84` is an
unconditional exit, but blessed's `screen.grabKeys` suppresses screen handlers
while the finder's textarea has focus, and the textarea drops control characters.
The finder is the one place in the app where the universal exit does not work.

**Do not fix it with a screen-level `ignoreLocked: ['C-c']`.** That option applies
to every `grabKeys` context, including the commit textarea, where Ctrl+C would
then quit diffstalker and discard a half-written commit message with no confirm.
Scope it: set and clear `screen.ignoreLocked` around the finder's lifetime, or
bind `C-c` on the finder's textbox directly.

Separate commit, before 5.1, CHANGELOG under `### Fixed`.

### 5.3 `/files` invalidation (build now)

Two opposite defects on the same endpoint.

**CLI, over-eager.** `ExplorerViewModel.setGitStatus` calls `loadFilePaths()` on
every status change (`packages/cli/src/state/ExplorerViewModel.ts:140`),
fire-and-forget, no in-flight dedupe, no dirty flag. That is a full REST
round-trip per watcher tick, for a cache the finder reads once per open. Replace
with a dirty flag plus a fetch at open, with an in-flight guard and a rerun
latch, the pattern `docs/web-perf-fix-plan.md` §5 already mandates for every
`refreshX`.

Note the failure path. `loadFilePaths` currently swallows connection errors
deliberately (`ExplorerViewModel.ts:645-651`: "logger.warn hits stderr and
garbles the alt-screen"), and `ModalController` bails silently on an empty list,
so on a connection loss pressing `/` does nothing at all. If the replacement
throws instead, `packages/cli/src/index.ts:81-85` turns an unhandled rejection
into `process.exit(1)` — a transient daemon hiccup would kill the TUI. Any
rejecting version needs a `.catch()` that covers the whole chain and a test
asserting a post-close rejection is not unhandled.

**Web, never invalidated.** The finder fetches once per open
(`FinderOverlay.vue:80-95`), which is correct for a transient overlay and is
asserted by its test. Nothing changes here today. It becomes wrong the moment any
surface holds the list open across a `state-change`, which is one more reason the
chosen design keeps the finder transient.

Also fix the finder-open race: `ModalController.openFileFinder` sets
`activeModalType` only after its await, so `hasActiveModal()` is false during the
fetch and hammering `/` on a slow daemon opens several `FileFinder` widgets,
leaking all but the last. Open synchronously.

### 5.4 Expand all gated diffs — bare `e` (build next)

Native Ctrl+F reaches everything mounted. Windowed virtualization was rejected
outright to keep it that way (`docs/web-diff-stream-architecture.md:5`), and
`content-visibility` sits on body wrappers so browser find still reaches skipped
content. The only genuine hole is files gated behind "Load diff" at over
`HUGE_FILE_CHANGED_LINES = 1500` changed lines
(`packages/web/src/components/DiffStack.vue:148`), plus whatever a future
cumulative row budget withholds.

**The fix is one action, not a search UI.** A header/footer button and bare `e`
that mounts every withheld body in the current stack. After it, Ctrl+F covers the
whole changeset. Bounded because it is an explicit user gesture, which is what
keeps it inside the perf plan's row-budget rules.

**Files.** `DiffStack.vue` (an exposed `expandAllGated()` next to `scrollToFile`),
`useGlobalKeys.ts` (bare `e`, below the `isEditable` guard at `:102` and below
the overlay gate at `:110`, no-op with nothing gated and no `preventDefault` on
that branch), `HotkeysOverlay.vue`, `FEATURES.md`, `CHANGELOG.md`.

**Caps and security.** No endpoint, no fetch — the store already holds the diff
text; only the DOM is withholding it. The cost is paint, and it is user-initiated.
Add a budget test asserting the action mounts exactly the gated sections and that
an already-expanded stack is a no-op.

### 5.5 Hunk outline — bare `o` (trigger-gated, cheapest item)

The in-scope answer to "which symbols did this change touch". Not a symbol index:
git's own hunk header.

The data already exists and is already memoized. `ParsedHunkHeader.context` is
parsed in `packages/core/src/view/diffPrimitives.ts:26-36`, carried on
`DiffHunkGroup` in `packages/web/src/utils/diffRows.ts` with ranges, stats and
`editedAt`, and rendered today at `packages/web/src/components/DiffView.vue:282`.
`DiffStack` already exposes `scrollToHunk(key, getHunkKey)` and already degrades
to the section header when a hunk is collapsed, gated or not yet landed.

**Placement.** A `useDismissable` popover anchored to the file section's sticky
header, the same z-index-20 layer as the repo and worktree switchers. Not an
overlay: it must not take the single overlay slot and must not scrim the diff it
describes. Entry: click the `[ N hunks ]` button, or bare `o` for the section
named by `ui.activeStackKey`. Its filter input is the third consumer of the 5.1
model, which is what makes that dedupe pay three times.

**Activation.** `stackEl.scrollToHunk(fileKey, () => hunk.key)` — literally the
call auto mode already makes. Zero new navigation machinery, nothing in the URL.

**Do not "fix" git's funcname while doing this.** Two traps:

- The `@@` context is produced in **two** places in `diffRows.ts`: once for
  display and once inside `hunkKeyFor`, which hashes it into hunk identity.
  Refining it in `parseHunkHeader` re-keys every hunk in the app and breaks the
  freshness flash, the DiffStack scroll anchors and the URL anchor. A golden
  hunk-key stability test is mandatory if anything in that area is touched.
- A client-side refinement from the three lines of leading context that `-U3`
  gives us (`packages/core/src/git/diff.ts:130`) was measured against this repo's
  last 291 TypeScript/Vue commits: it changes **303 of 4580 hunks, 6.6%**. The
  other 93.4% return git's text unchanged, and that is where the real problem
  lives — git's column-0 matcher reports `export class App {` (265 hunks),
  `import {` (108), `onBeforeUnmount(() => {` (104). Not worth the two vocabularies
  it would put in one column.

If anything about the funcname is worth doing, it is the opposite and it is
five lines: **suppress a context that does not parse as a named declaration**, so
`import {` and `onBeforeUnmount(() => {` stop being displayed as if they were
symbols. That removes more falsehood than the refinement and costs no new module.

**Tests.** The outline lists every hunk with its ranges, stats and context;
activation calls `scrollToHunk` with the right keys; a binary or withheld file
renders no button; the popover closes on outside click and on Escape without
touching the global overlay path.

### 5.6 Changed-set filter — bare `/` plus a chip (trigger-gated)

The product's real search gesture, and the one item on this list that
`docs/feature-review-0.9.0.md:104` explicitly parked. Build it the day §6's
trigger fires, not on inference.

**Shape: a filter, never a query box.** Rows disappear, the set stays a set. No
syntax, no prefixes, no modifiers beyond fzf's smart-case. Two of the three
drafts proposed typed scope prefixes (`+`, `#`); rejected, because nothing in
this app has typed syntax anywhere and `feature-review-0.9.0.md:114`
boundary-rejects a journal query language and a free-text revspec box by name.

**Corpus, entirely client-side.** `repo.shared.status.files` in Changes,
`compare.compareDiff.files` in Compare, `repo.history.commits` in History. Zero
network, zero new endpoints.

**Implementation.** Wrap one existing computed per view — `categories` in
`ChangesView`, `files` in `CompareView` upstream of `buildFileTree`, `commits` in
`HistoryView` — so keyboard nav, tree building and `stackFiles` all keep working
over a shorter ordered list. Narrowing `categories` also narrows `stackFiles`,
which makes the filter the row-budget lever on a several-hundred-file changeset.

**State.** Session-only, in a new `stores/filter.ts`, `shallowRef` with
whole-value replacement, `watch(() => repo.repoId, reset)` copying
`stores/explorer.ts:134-137`. Never persisted (`stores/ui.ts` header rule). Never
in the URL (section 3). Refocusing the input on a second `/` press needs a
seq-stamped one-shot ref, the same trick `stackScrollRequest`
(`stores/ui.ts:156-162`) uses and for the same reason: a plain value ref is inert
the second time.

**Selection identity.** Results derive from state that moves under them — SSE
status updates, staging, commits. Selection must be a stable id (path, or
`s:`/`u:`+path, or short hash) re-resolved to an index on every recompute, with a
vanished selection clearing rather than sliding. This is the class of bug the
Changes anchor already documents, and it bites harder in a list that also
recomputes on every keystroke.

**Honest copy, everywhere.** Every surface names its corpus and its bound:
`4 of 214 changed files`, `of the 100 commits loaded`, `Compare not opened yet`.
"No match" and "not loaded" must never render the same. A filter that hides the
whole set must render a dedicated note, not the clean-tree state — `isClean`
reads the raw status and stays false, so the app never claims a dirty tree is
clean.

**Bounded scan discipline**, even though these corpora are small, so a later
line-content scope cannot land in the F3 hazard class by accident: minimum query
length, the shared debounce constant, a module-scoped generation guard, per-group
and total caps, and caps asserted as budget tests in the same family
`docs/web-perf-fix-plan.md` §5 already asks for.

**Interaction with follow mode — decide this before building.**
`useFollowMode` activates a different repo and forces the view to Explorer with
`revealFile`. That is the app's headline feature and it takes the viewport. The
rule must be explicit and tested: a `follow-change` that activates a different
repo resets filter state to empty, and the filter must not fight the view switch.
Add a case to `useFollowMode.test.ts`. None of the three drafts addressed this.

**Colour.** If a match run is ever painted inside a diff row, it needs its own
token (`--match-bg` / `--match-fg`) added per theme. Do **not** reuse `--warn`:
it was tuned for WCAG AA against chrome backgrounds, not against `--diff-add-bg`
/ `--diff-del-bg`, and in `dark-ansi` those are the raw ANSI `green`/`red` while
`--warn` is `#cdcd00`. The two colorblind themes exist because hue-only
signalling fails there, and `.hit`'s only non-colour signal today is
`font-weight: 600`. Check all six by hand.

**Accessibility.** There is currently **no** `aria-live` region anywhere in the
web app (verified: no matches in `packages/web/src`). A live result count is a
new pattern, and a chatty one. If one is added, it must announce the *applied*
query, not the live one, and read as a complete sentence. Do not make the filter
a `role="tablist"` with tabs Tab cannot reach — the input claims Tab and
`useFocusTrap` yields to it, so that would be a keyboard trap by construction.

---

## 6. Risks and open questions

1. **Freeze violation is the biggest risk.** `docs/feature-review-0.9.0.md` is a
   standing stop-sign and §4 already logged the changed-set filter as
   real-but-not-now. Items 5.1 to 5.3 are defect fixes and dedupes and are inside
   what the doc permits. 5.4 restores a browser affordance the app's own gate
   withholds. 5.5 and 5.6 wait. Cheap is exactly how frozen features get built
   early — guard it in review.
2. **fzf and the published tarballs.** Removing `fzf` from
   `packages/cli/package.json` would break the published CLI. See 5.1. Any change
   in this area needs a real `bun run build:prod` plus a pack test, not just a
   green unit suite.
3. **Hunk identity.** `hunkKeyFor` hashes the `@@` context. Anything that touches
   `parseHunkHeader` re-keys the whole app. Golden-key test, mandatory.
4. **Follow mode taking the viewport** while a filter or popover is open. Decided
   above, untested today.
5. **`workingDiffs` is not always warm.** It is gated on `workingDiffsActive`
   (`packages/web/src/stores/repo.ts:687,1038`) — the map is empty until the
   Changes view has been activated once, and entries are `markRaw`'d, so only
   `seq` bumps are observable. Any future surface that scans diff text must
   handle both, or it will silently report zero hits on a cold load. This is the
   single fact that kills the "search all changed diffs" designs as drawn.
6. **Lint budget.** 0 errors, exactly 20 warnings (6 core, 11 cli, 3 web). New
   components with several states are the shape that trips sonarjs
   cognitive-complexity. Keep scanners and filters as small pure functions in
   `utils/` — that is also what makes their caps testable without mounting
   anything.
7. **Docs gate.** `FEATURES.md` mentions the finder in several places and the
   CHANGELOG needs an entry. The dedupe in 5.1 is user-invisible: one
   `### Changed` line, `FEATURES.md` untouched.
8. **Amend `docs/feature-review-0.9.0.md` §4 in the same commit as 5.1.** Add the
   rejections from section 7 below. That doc exists so the same ground does not
   get re-covered, and this exercise re-covered it from scratch because the
   ground was never recorded. It is the highest-leverage documentation change
   available and it is nearly free.

Open, and deliberately left open: whether the CLI ever gets the filter. It is
demoted, a terminal cannot express the chords a web-first design wants, and
bare-key parity (`/`, `a`, `f`) is the only parity that survives. Decide when the
web version has actually shipped.

---

## 7. Not being built (record this in `feature-review-0.9.0.md` §4)

- **Repo-wide content search / grep.** Wrong corpus, worst engineering bill.
  New endpoint walking arbitrary repo content on the browser-reachable surface,
  on an unbounded git client, over non-UTF-8-safe output, needing its own
  concurrency gate — and it duplicates the editor already open behind the window.
  It is also a timing oracle: GETs are CSRF-exempt, a repo id is
  `sha256(worktreeRoot).slice(0,12)` and computable offline from a guessed path,
  and CORS blocks reading the response but not measuring it.
- **In-file symbol search.** No symbol model exists in any of the five packages.
  Requires tree-sitter or ctags inside the published `diffstalkerd` tarball, plus
  an index, a cache and an invalidation story.
- **Workspace symbols, find-references, go-to-definition.** Named to close the
  escalation path. Accepting in-file symbols buys the whole semantic-analysis
  stack.
- **Search and replace, in-file or project-wide.** Permanent. The web UI's only
  git mutation is file-level stage/unstage, and that boundary is the product.
- **Pickaxe (`git log -S` / `-G`), `log --grep`, blame search.** The pickaxe is
  the genuinely git-native search and still no: same species of free-text query
  surface over git internals that §4 already boundary-rejected as "a free-text
  revspec box", needs a new bounded endpoint, and moves the tool toward being a
  git client. The author half also runs into the standing rule against anything
  that measures the person rather than the code.
- **Command palette.** Scales with the action surface, and ours is about two
  dozen keys already fully listed in a hotkeys overlay in both UIs.
- **Cross-repo search.** §4 already boundary-rejects a cross-repo journal or
  dashboard. The UI is deliberately one repo at a time.
- **Saved searches, search history, regex or DSL modifiers.** fzf smart-case
  covers the practical need. Anything past it grows syntax, and syntax is the
  query-language family §4 rejects twice.
- **An in-app find-in-diff.** Native Ctrl+F already works for everything mounted,
  by design. Replacing it with a worse in-page find is a downgrade. The one hole
  is a mount hole, and 5.4 closes it with a button.
- **`q` in the URL.** A query is a filter over an existing set, not a place.
  Write that sentence into `useUrlSync.ts`'s header when the filter ships, so the
  next person cannot cite `base` as precedent.
- **Configurable keybindings.** Section 2.

---

## 8. Sequencing

**Slice 0 — today, independent of everything.** Fix the CLI's swallowed Ctrl+C
(5.2). One file, one CHANGELOG line under `### Fixed`. It is the only defect here
that affects a shipped release.

**Slice 1 — the first real slice.** The synchronous `finderModel.ts` (5.1) plus
rewiring both finders. Behaviour byte-identical; `FinderOverlay.test.ts` passes
untouched. Net negative line count, one tested copy, zero new keys, zero new
endpoints, zero new dependency edges. Entirely inside what the freeze permits and
needs no trigger.

**Slice 2 — same week, nearly free.** Amend `docs/feature-review-0.9.0.md` §4
with section 7 above. Prevents the next re-derivation.

**Slice 3 — corrections to shipped code.** The `/files` invalidation defects and
the finder-open race (5.3).

**Slice 4 — the only correctness argument any search design actually made.**
Expand all gated diffs on bare `e` (5.4), after which native Ctrl+F reaches the
whole changeset. One button, no search UI.

**Then stop.**

When the trigger fires — a monorepo, a several-hundred-file changeset, heavy
submodule use, or a real user asking — build 5.5 (hunk outline) first because it
is nearly free, then 5.6 (changed-set filter). Answer these three before writing
any of 5.6: the follow-mode interaction (risk 4), selection identity across SSE
churn (5.6), and the match-colour token per theme (5.6).
