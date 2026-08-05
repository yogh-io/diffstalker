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

---

## 9. Override: what the author decided to build

Sections 1 to 8 above were written under the freeze. Section 1 concluded: build
nothing search-shaped. **The author has overridden that**, 2026-08-05, and this
section plus section 10 record what replaces it. Sections 1 to 8 stay as written
— the analysis in them is still the reason the design below has the shape it has.

### The trigger fired

`docs/feature-review-0.9.0.md:149-151` names the first trigger: "Real users
arrive. A single bug report or feature request from someone else outweighs
everything in this document, because it is evidence and this is inference." The
author is the sole author of the project, of the freeze, and of this document. He
asked for two things by name — repo-wide content search in the web UI, and
in-file symbol search — and said the symbol side needs "a lasting and robust"
answer to the language problem. That is the evidence the freeze asked for. It has
arrived, and the decision to build is made.

The scope of the override is exact. Two of section 7's rejections are lifted:

- **Repo-wide content search / grep.** Built. Section 10.2.
- **In-file symbol search.** Built. Section 10.1.

Everything else in section 7 **stays rejected**, unchanged and for the reasons
already recorded there: workspace symbols, find-references and go-to-definition;
search and replace; pickaxe (`git log -S`/`-G`), `log --grep` and blame search; a
command palette; cross-repo search; saved searches, search history, regex and DSL
modifiers; an in-app find-in-diff; `q` in the URL; configurable keybindings.
Accepting in-file symbols does **not** buy the semantic stack — 10.1 states in
its own terms why nothing built there is a substrate for cross-file resolution.

Section 5.6 (the changed-set filter) is **not** part of this override — it landed
on its own, under its own trigger, and bare `/` is now taken by it
(`packages/web/src/composables/useGlobalKeys.ts:131-135`,
`packages/web/src/stores/filter.ts`). Nothing in section 10 may claim `/`, and
nothing in section 10 narrows a list: text search and the outline both **locate
and jump**, which is a different verb on a different corpus. Keeping the two verbs
on different keys is the point.

### The corpus rule, amended

Section 1's corpus rule said: every search surface reads state the client already
holds. Repo-wide grep breaks that rule by definition, so the rule is replaced
rather than quietly bent:

> **Exactly two surfaces may read repository content the client does not already
> hold. Both live in the daemon, both are bounded by hard caps declared as
> constants, and both refuse rather than truncate silently.** Symbols ride the
> existing `/file` read and return strictly less information than that endpoint
> already serves. Grep is one `POST` route with per-file, per-result, byte and
> time caps. Any third such surface is a new decision, not an extension of this
> one.

Everything else in section 3 stands untouched: no new UI layer, no sixth view, no
dock, nothing about a query in the URL.

### Keybindings, corrected

Section 2's analysis of the three remembered chords is unchanged and still
correct. Ctrl+H is Replace in VS Code, History in Chrome and Edge, and ⌘+H is
macOS "hide application", which cannot be intercepted at all. Ctrl+O is the
browser file picker. Ctrl+Shift+O — the actual VS Code go-to-symbol chord — opens
Chrome's Bookmark Manager and Firefox's Library, so it is unavailable too. All
three stay rejected.

What we bind now:

| Key | Action | Status |
|---|---|---|
| Ctrl/⌘+P | toggle the file finder | shipped, unchanged |
| Ctrl+F | browser find-in-page | **permanently the browser's** |
| Ctrl/⌘+Shift+F | toggle repo text search | **new, §10.2** — §2's "deliberately not taken" is lifted |
| bare `F` (Shift+F) | toggle repo text search | new, §10.2 — the bare-key twin, and the CLI's binding later |
| bare `o` | outline of the active file | new, §10.1 |
| bare `e` | expand all gated diffs | shipped (§5.4) |
| bare `/` | narrow this list | §5.6, landed — **not available to §10** |
| Ctrl+H, Ctrl+O, Ctrl+Shift+O | — | rejected |

Two bindings for text search is deliberate, and it is the same shape Ctrl+P
already has. Ctrl/⌘+Shift+F is the chord every editor in section 2's verified
table agrees on (VS Code, JetBrains, Zed, Sublime), it is unbound in Chrome,
Firefox and Safari, and it is expressible identically on both platforms — so it
passes section 2's own test. It goes **above** the `isEditable` guard
(`useGlobalKeys.ts:121`), like Ctrl+P, so it also closes the overlay while the
query input has focus.

Bare `F` exists because section 2's closing rule still holds: a terminal cannot
express Ctrl+Shift+letter, so bare-key parity is the only parity worth designing
for. `F` is free in the web and free in the CLI (`packages/cli/src/KeyBindings.ts`
binds `f`, `S-g`, `S-u`, `S-a`, `S-z`, `S-w`, `S-t`, `S-n` — not `S-f`). The
mnemonic is `f` follow, `F` find. Bare `o` is free in both for the same reason
(the CLI binds `g`, not `o`).

`preventDefault()` only on the branch that acts, in both cases. With no active
repo the keys stay the browser's.

---

## 10. Build plan

### 10.1 In-file symbol search

#### 10.1.1 The language question, first

Everything else in this feature is plumbing. The language question is the part
that decides whether it is worth having, so it is settled before anything else.

**The engine is tree-sitter, compiled to WebAssembly, running inside
`diffstalkerd`, with outline queries we write ourselves.** Grammars are vendored
`.wasm` files checked into the repo and shipped inside the `diffstalkerd` tarball.
The queries are ours — not upstream `queries/tags.scm`, which is tuned for
GitHub's cross-file code navigation, emits `@reference.*` alongside
`@definition.*`, and misses type aliases, enums, top-level consts and namespaces.

**Why not the cheaper options.** Three were designed and measured against this
repo before the choice was made.

- **A regex rule table** (one scanner, zero dependencies, ~2 KB gzipped) reached
  99.1 / 94.1 precision/recall in-sample on this repo and **84.8 / 81.4 on files
  from nine projects it had never seen**. A tuning round aimed at its single
  largest out-of-sample defect made out-of-sample F1 *worse* (83.0 to 81.9). That
  is a measured demonstration that the gap does not close with more rules. One in
  six symbols wrong on unfamiliar code is a permanent bug factory, and the
  request was "robust". The failures are structural, not tunable: object-literal
  methods are invisible, assignment to an existing binding accounts for half the
  misses in this repo, decorated members vanish.
- **A lexical brace-counting scanner** reports 89.9% enclosing-symbol accuracy —
  but only on this repo, which is exactly the corpus where the regex table scored
  99.1 before dropping 15 points on unseen code. It never reports an
  out-of-sample number, so its real ceiling is unmeasured. Its own honest-ceiling
  notes name the killers: one `#ifdef` that unbalances braces silently corrupts
  every span below it in the file, and a regex-literal masking bug desynchronizes
  the counter for the rest of the file.
- **A bundled universal-ctags binary** disqualifies itself in its own
  measurements: **0 symbols on all 29 `.vue` files** here, 12 of 75 on
  `stores/repo.ts`, 1 of 22 on `stores/explorer.ts` — because every Pinia store
  and composable in this app is a function body passed as an argument, and ctags
  stops at `defineStore('ui', () => {`. Around that: five new npm packages
  published in lockstep against a release script that derives exactly two
  manifests today, no official prebuilt stable binaries (so you pin a nightly),
  no win-arm64, a GPL-2.0 binary inside an MIT project, and a pipe protocol with
  no error channel that hangs a naive reader on a malformed frame.

**Tree-sitter was verified here, not taken on trust.** A 9-pattern TypeScript
outline query over all 305 `.ts`/`.vue` files in this repo (77,150 lines) found
13,272 symbols with exactly one parse error. Error recovery — the property that
decides whether this is usable while a file is being edited — held under
adversarial edits to `packages/web/src/stores/repo.ts` (1,845 lines, 243 baseline
symbols): truncated to 60% it found 143 of the 145 symbols in range; with an
incomplete `function foo` spliced into the middle it returned 243 of 243 with one
name lost (the function whose body the splice landed in); with three unbalanced
braces injected it lost nothing. Damage stays local to the broken construct.
Timings: `Parser.init` 8.1 ms, one grammar load 4.2 ms, 1.92 ms per file across
this repo, 0.94 ms per file over 400 real Java files (69,492 lines, 7,143
symbols, 0 parse errors) from the author's own work repos.

**Extensible mechanism, bounded shipped set.** That is the direct answer to
"extensible, or just accept limitations". It is both, and which part is which is
a decision, not an accident.

The mechanism is open: adding a language is a vendored `.wasm` plus a `.scm`
query file. No TypeScript change, no build change, no new dependency. Java proved
that here — seven query patterns, zero parse errors on 400 real files.

The set is closed at the repo boundary. Grammars are checked-in artifacts with
recorded sha256s. There is **no runtime grammar loading, no plugin surface, no
user-supplied wasm path, and never grammar bytes from repo content**.
`docs/feature-review-0.9.0.md:114` already boundary-rejects a plugin system, and
loading a grammar the repo controls would be arbitrary wasm execution on the
daemon's own origin — follow mode opens repos automatically from a hook file, so
nobody would have to click anything. Write that reason into the module header
next to the `grammarDir` constant.

**Launch languages**, grounded in what the author actually works in (counted
across all 49 local repos, tracked files only):

| Language | Extensions | Here | Across repos |
|---|---|---|---|
| TypeScript | `.ts`, `.mts`, `.cts` | 276 | 1,557 in 17 repos |
| Vue | `.vue` | 29 | 462 in 16 repos |
| JavaScript | `.js`, `.mjs`, `.cjs` | — | 788 in 21 repos |
| Java | `.java` | — | 14,344 in 15 repos |

Dropped from the generic "tier 1" list because the author does not work in them:
Go (zero repos), Rust (one repo), TSX (one repo), C, C#, C++. That is what turns
the cost objection from 4.3x into 2.4x.

**Vue has no grammar and does not need one.** The only `tree-sitter-vue` on npm
is 0.2.1 from May 2022. Instead a ~12-line scanner finds the `<script>` block
bounds and passes them as `includedRanges` to the TypeScript grammar. Verified:
all 29 `.vue` files here parse with zero errors and correct **file-absolute** line
numbers. `AppHeader.vue`, which upstream's `tags.scm` reports as 0 symbols,
returns 12 under our query. That single result is the whole thesis: the parser was
already right, the shipped query was wrong, and the query is ours.

This is standing policy, not a Vue special case. Any container format (SFC,
Astro, Markdown fences, templating) gets a block scanner returning
`includedRanges` mapped onto the embedded grammar, never a container grammar.

**Adding language N+1 — seven steps.** Steps 1, 2, 4, 6, 7 are mechanical, about
an hour. Step 3 is the real work and is why the set is bounded.

1. **Get the wasm.** `npm pack tree-sitter-<lang>` and take
   `package/tree-sitter-<lang>.wasm` from the tarball. Verified present in the
   first-party packages for typescript (0.23.2, 1,413,849 B), tsx, javascript
   (0.25.0), java (0.23.5, 414,641 B), python (0.25.0) and go (0.25.0). Fallback:
   `npm pack @vscode/tree-sitter-wasm` (0.3.1, 16 grammars). Last resort:
   `npx tree-sitter-cli build --wasm` in a grammar checkout, which needs
   emscripten on a human's machine and never in CI.
2. **Vendor it.** Copy to `packages/daemon/grammars/tree-sitter-<lang>.wasm`, add
   its sha256 to `grammars/checksums.json`, add a test asserting the checksum and
   that the grammar loads. Checked-in artifact, never a build-time download — the
   published tarball must be reproducible offline. Add the directory to
   `packages/daemon/package.json` `"files"`.
3. **Write `packages/core/src/symbols/queries/<lang>.scm`.** Do not copy
   upstream's `tags.scm`. Start from the grammar's `node-types.json`. Capture
   `@name` plus exactly one `@symbol.<kind>` per pattern. Budget half a day per
   language to write and tune against real files. Java took 7 patterns,
   TypeScript took 9.
4. **Register the extensions** in `packages/core/src/symbols/languages.ts`
   (`EXTENSION_TO_GRAMMAR`). Keep this map separate from
   `view/languageDetection.ts:7` — that one answers to hljs and calls `.vue`
   "xml", which is right for highlighting and wrong for structure. Highlighting
   and outlining are allowed to disagree about coverage.
5. **Container formats**: add a block scanner returning `includedRanges` and map
   to the embedded grammar (see Vue above).
6. **Golden fixtures**: two or three real files per language plus their expected
   symbol lists, asserting exact kind, name **and line**. A wrong line number is
   worse than a missing symbol. Add a truncated copy of one file as a second
   case, because truncated-file behaviour is what makes this usable mid-edit.
7. **Docs**: the supported-language list in `FEATURES.md` (that list is the
   user-facing contract, and the popover's "no outline for `.rs`" copy reads from
   the same constant), plus `CHANGELOG.md`.

The rule that onboarding cannot fix: **if a grammar parses a language badly, or
the query cannot be made accurate, the language is not offered.** There is no
half-credit tier.

**What it will get wrong.** Stated plainly, because a feature like this rots the
day its limits stop being written down.

- **No outline at all for an unsupported language.** Open a `.go`, `.rs`, `.cs`,
  `.rb` or `.php` file and the popover says "no outline for `.rs`". That is the
  price of not shipping a 400 KB grammar per language to every user who never
  opens one.
- **This is syntax, never semantics. Nothing resolves.**
  `Object.assign(Foo.prototype, {…})` methods are invisible.
  `export { thing } from './other'` is not a declaration. Decorator-synthesized
  members, macro-generated symbols and anything produced at build time are
  permanently absent. Overloads and get/set pairs come out as same-named entries
  on different lines with no disambiguation. Cross-file is permanently out and no
  substrate for it is being built.
- **The outline describes exactly the text `/file` returned.**
  `readFileForDisplay` cuts at `MAX_DISPLAY_LINES = 5000`
  (`packages/core/src/git/explorerData.ts:35`) and refuses over
  `MAX_FILE_SIZE = 1 MiB` (`:32`). A 12,000-line file gets an outline of its first
  5,000 lines, and the popover header must say "outline of the first 5,000 of
  12,431 lines". Never silently partial.

**Packaging cost.** Measured gzip: runtime 81,111 B + typescript 134,049 B +
javascript 48,211 B + java 49,771 B = **313,142 B**. The published `diffstalkerd`
today is 224,779 B compressed / 671,611 B unpacked. So roughly 538 KB compressed,
a 2.4x tarball. **Web bundle delta: zero bytes** — none of it reaches the browser.
`web-tree-sitter` itself bundles to 75.6 KB minified under
`bun build --minify --target node`, and the minified bundle was verified to parse
TypeScript correctly under node, so `build:prod` needs no change.

#### 10.1.2 Architecture

**Daemon, not browser. This is forced, not preferred.**
`packages/daemon/src/security.ts:236` sets `script-src 'self'` with no
`'wasm-unsafe-eval'`, and `:245` sets `worker-src 'none'`. Chrome gates
`WebAssembly.instantiate` on `script-src`. Running the parser in the browser
means reversing two deliberate hardening decisions for a convenience feature.
Daemon-side also means the CLI becomes a consumer over the same REST call with
zero engine code of its own, which is what the author asked for.

**Packages and layers.**

- `packages/core/src/symbols/types.ts` — browser-safe, **types only**, importable
  everywhere. `SymbolKind`, `FileSymbol { kind, name, startLine, endLine, column,
  parent }`, and the `SymbolOutcome` union. Lines are 1-based and in the same
  coordinate space as the content `/file` returns.
- `packages/core/src/symbols/extract.ts` — **Node only**. Imports
  `web-tree-sitter` and `node:fs`. `createSymbolExtractor({ grammarDir, maxBytes,
  deadlineMs, cacheEntries })` returns `{ supported(), extract(relPath, content),
  residentLanguages }`. `extract` is async only because `Language.load` is; the
  parse itself is synchronous. **It never rejects** — failures become
  `{ status: 'unavailable' }`, matching the daemon's rule that errors surface as
  state, not exceptions.
- `packages/core/src/symbols/queries/*.scm` — ours.
- `packages/core/src/symbols/languages.ts` — `EXTENSION_TO_GRAMMAR`.
- `packages/core/src/symbols/mapping.ts` — `symbolAt(symbols, line)` and
  `markChangedSymbols(symbols, hunks)`. Pure, browser-safe. This is where the caps
  get budget-tested without mounting anything, which is what keeps the sonarjs
  cognitive-complexity budget where it is (risk 6).
- `packages/daemon/grammars/*.wasm` + `checksums.json` — checked-in artifacts,
  listed in `package.json` `"files"` alongside `dist/index.js`, `dist/web` and
  `bin`.

**`extract` takes bytes, never a path.** `extract(relPath, content)` uses
`relPath` only to pick a grammar and echoes it nowhere. Making the absence of a
filesystem parameter structural means no future refactor can hand it a
repo-controlled path by accident, and it guarantees symbol line numbers and
rendered line numbers come from the same bytes. A write landing between two reads
would otherwise produce off-by-N jumps that reproduce only under a fast editor.

**Dependency-cruiser**, severity `error`: `packages/web/src` and
`packages/cli/src` may not import `@diffstalker/core/symbols/extract`. Same shape
as the existing CLI bans on `managers/*`, `simple-git` and `chokidar`.
`symbols/types` and `symbols/mapping` stay importable everywhere. The root
workspace config catches the cross-package case.

**Endpoint — no new route.** Symbols ride the existing file read:

```
GET /repos/:id/file?path=<rel>&symbols=1  ->  FileForDisplay & { symbols: SymbolOutcome }
```

Without `symbols=1` the response is byte-identical to today, so every existing
client and test is untouched. `parseBoolParam` already exists
(`packages/daemon/src/routes/shared.ts:126`). One `readFileForDisplay` call
produces both content and symbols, so there is one truncation, one line numbering
and no coherence race — a symbol's line and the file pane's gutter cannot
disagree. It reuses the already-hardened `requireRepoRelPath` +
`requireRealRepoPath` pair (`routes/explorer.ts:84-85`) and adds **no new
browser-reachable corpus**: symbols are strictly less information than the
content that endpoint already returns. That is why none of section 7's grep
hazards apply here — no CSRF-exempt GET walking new content, no unbounded git
client, no non-UTF-8 git output, no timing oracle.

Capability probe, so the UI can hide a dead key rather than offer one:

```
GET /version -> { ...VersionState, symbols: { languages: string[] } }
```

`packages/daemon/src/routes/version.ts:13`, and the web already polls it hourly.

**Client.** `packages/client/src/client.ts:346` gains one optional argument:

```ts
file(id: string, path: string, opts?: { symbols?: boolean }):
  Promise<FileForDisplay & { symbols?: SymbolOutcome }>
```

No wire decoder needed — no Dates, no Maps.

**Cache and invalidation: there is none, structurally.** Three process-lifetime
caches inside the extractor: `Language` objects loaded lazily on first use (4.2 ms
each, so a TypeScript-only repo pays for one grammar and not four), compiled
`Query` objects built once per language, and a 64-entry LRU **keyed on
sha256(content)**. Because the cache key *is* the content, new content is a new
key and old entries age out. There is nothing to subscribe to `state-change`,
nothing to reconcile against the SSE hub, nothing that can go stale. No manager,
no per-repo state — the same stateless-by-deletion shape CLAUDE.md records for
history, compare and explorer after the daemon split. Incremental reparse is
deliberately unused: the daemon has stateless file reads, not editor buffers, and
a cold parse is 1.92 ms.

**Bounds.** `SYMBOL_MAX_BYTES = 512 KiB`, `SYMBOL_DEADLINE_MS = 50`. The deadline
is enforced through `parse()`'s `progressCallback`, verified to make `parse()`
return `null` on cancellation. Binary is caught by `isBinaryContent` inside
`readFileForDisplay` before any parse. No worker thread in v1 — the 50 ms ceiling
makes one unnecessary; the escape hatch (move the extractor into one
`node:worker_threads` worker) stays contained if SSE latency ever complains.

**The status union — the single most important UI rule here.** These six states
must never render the same string:

| Outcome | Copy |
|---|---|
| `ok` with an empty list | "no symbols in this file" |
| `unsupported: 'language'` | "no outline for `.rs`" |
| `unsupported: 'binary'` | "binary file" |
| `unsupported: 'too-large'` | "file too large" — there is no content at all, never "no symbols found" |
| `ok` but the file was truncated | "outline of the first 5,000 of 12,431 lines" |
| `unavailable: 'deadline' \| 'error'` | "outline unavailable" |

Collapsing any pair of them is the precise mechanism by which this feature
becomes quietly wrong.

**Fallback policy.** An unsupported language returns
`{ status: 'unsupported', reason: 'language' }` and nothing is attempted. No
regex second pass, no heuristic, no degraded list.

This is not a fallback for a failing primary path, and the distinction is exact.
The banned pattern is: a primary path fails, a secondary path silently produces a
worse answer in the same shape, and the failure is hidden. Here there is no
failing primary path — a `.rs` file is an input the feature has no answer for,
and it says so in words.

The rule that keeps it honest: **never degrade a supported language.** If the
grammar loads and the parse errors, ship what tree-sitter's error recovery gives
— that is the parser working as designed, verified at 243 of 243 symbols through
a spliced broken function. If the deadline expires, the answer is
`unavailable: 'deadline'`, rendered as "outline unavailable" — never an empty
list, and never a regex approximation. **Never wire a regex scanner behind a
tree-sitter failure.** That would be the banned pattern exactly, and it would
hide the deadline hazard: a 200 KB high-entropy blob or a minified bundle that
slips past the NUL scan is a real state that must be visible.

Where an outline is unavailable in a **diff** context, the fall-through is the
hunk list from §5.5 — git's own `@@` headers, labelled "from git's hunk headers"
so the two vocabularies are never mixed in one column. A staged-vs-HEAD, compare-
base or historical diff degrades to hunk-only unconditionally: symbol lines are
worktree lines and cannot be mapped honestly, and a label pointing at the wrong
function is the failure that discredits the whole feature.

**Never put a scanned symbol and git's `@@` funcname text in the same column.** A
row shows one or the other and says which.

**Build the outline from the `/file` read, never from `workingDiffs`.** That map
is gated on `workingDiffsActive` (`stores/repo.ts:687,1038`) and is empty until
the Changes view has been activated once, with `markRaw`'d entries so only `seq`
bumps are observable — risk 5, the fact that killed the "search all changed
diffs" designs. Deriving from `/file` makes the feature structurally immune.
Write that reason into the module header so nobody moves it later.

**Web.** `stores/explorer.ts` gains `fileSymbols: SymbolOutcome | null`, set from
the **same** fetch that sets `file` (`openFile`, `stores/explorer.ts:344`), so it
cannot drift. A new `components/OutlinePopover.vue` on the existing
`useDismissable` z-20 layer — the repo/worktree switcher layer — **not** an
overlay: it must not take the single overlay slot (`OverlayName`,
`stores/ui.ts:32`) and must not scrim the file it describes. Transient, never
persisted, never in the URL. A `follow-change` that activates a different repo
closes it, mirroring `watch(() => repo.repoId, reset)` at
`stores/explorer.ts:134-136`, with a case added to `useFollowMode.test.ts` —
risk 4, now decided.

**Keybinding: bare `o`**, and it **absorbs §5.5** rather than competing with it.
One key, one word, one mental model. In the Explorer it lists the open file's
symbols and jumps to a line. In Changes it lists the same symbols annotated with
which ones contain hunks, and jumps via the existing `scrollToHunk`
(`DiffStack.vue:1204`, exposed at `:1243-1246`). A file with no symbols falls
through to the pure hunk list, which is §5.5 exactly. Placement copies §5.4's
`e`: below the `isEditable` guard at `useGlobalKeys.ts:121` and below the overlay
gate at `:129`, with `preventDefault()` only on the branch that acts. Its
type-to-filter input is the fifth consumer of §5.1's `finderModel` (after the two
finders and §5.6's filter).

**Hunk identity is untouched.** Symbol spans are computed independently and
mapped onto hunks the client already holds. Nothing goes near `parseHunkHeader`
(`core/view/diffPrimitives.ts:26`) or `hunkKeyFor` (`web/src/utils/diffRows.ts:224`),
which hashes the `@@` context into hunk identity. Risk 3 does not fire; the
freshness flash, DiffStack scroll anchors and URL anchors are unaffected, and the
golden hunk-key stability test stays green because nothing in that path changes.
**Do not replace git's funcname with a tree-sitter symbol in the hunk header.** It
would re-key the whole app for no gain the popover does not already deliver.

**Grafted, and shipped first, on its own commit:** pass
`-c core.attributesFile=<bundled>` in `packages/core/src/git/gitClient.ts:38` so
git's 28 built-in `funcname` drivers turn on. Verified lowest precedence, so an
in-tree `.gitattributes` always wins, and it does not force a binary file to be
diffed as text. Measured +50 points on Python (36.6% to 86.9% correct enclosing
symbol). One flag, improves every `@@` header in both UIs, including for every
language we will never ship a grammar for, and completely independent of the
symbol feature. **Its trap:** `diff=typescript` is accepted silently and behaves
like a nonexistent driver, so the bundled attributes file must only name drivers
verified present in the running git — asserted by a test that diffs a fixture
with and without the driver and checks the funcname actually changed.

**Build and CI.** `web-tree-sitter` goes in `devDependencies` and is bundled by
the existing `bun build --minify --target node`. The daemon's three runtime deps
(`chokidar`, `simple-git`, `ignore`) stay three. Load the runtime wasm with
`Parser.init({ wasmBinary: fs.readFileSync(...) })` rather than relying on
`locateFile` path resolution — both are supported (verified in the shipped
`web-tree-sitter.js`), and passing bytes removes the only emscripten packaging
hazard in a tarball with no `node_modules`. Add "open a file with `symbols=1`" to
the existing CI tarball-boot-under-node gate (commit `e0a3253`). Pin
`web-tree-sitter` exactly, the way `neo-blessed` is pinned, and add a startup test
that loads every shipped grammar so an ABI bump fails in CI rather than in a
user's terminal (shipped grammars are ABI 14 for typescript and java, 15 for
javascript; the runtime accepts both).

**Tests.** Golden fixtures per language with exact kind, name and line, plus one
truncated file per language. A checksum test per grammar. A parse-error-recovery
test (spliced broken function, unbalanced braces). A deadline test asserting
`unavailable`, not an empty list. A `.vue` test asserting file-absolute line
numbers. Route tests: `symbols=1` absent gives a byte-identical response; each
`SymbolOutcome` variant round-trips. Web: the popover renders each of the six
status strings distinctly, closes on outside click and Escape without touching
the global overlay path, and a repo switch closes it.

**Ground-truth generators must emit checked-in goldens offline, never call the
compiler at test time.** TS 7.0 ships no programmatic compiler API (CLAUDE.md
records this as why typescript-eslint and vue-tsc are blocked until 7.1), so a
live-compiler fixture harness would die on the exact upgrade this repo is waiting
for.

### 10.2 Global text search

#### Engine

**`git grep`, spawned directly — never through `simple-git`.**

`createGit` (`packages/core/src/git/gitClient.ts:38`) has no timeout and no
`maxBuffer`, and `git.raw()` decodes stdout as a UTF-8 string, replacing every
invalid byte with U+FFFD. Both are disqualifying here. The pattern to copy
already exists in this repo: `packages/core/src/git/blob.ts` spawns git with
`encoding: 'buffer'`, an explicit timeout and an explicit byte budget, behind a
hardening prefix (`blob.ts:120-128`).

New file: **`packages/core/src/git/grep.ts`** (Node only, plus `.test.ts`). Exact
argv, every flag load-bearing:

```
git -c core.fsmonitor= -c core.pager=cat -c core.hooksPath=/dev/null \
    --literal-pathspecs \
    grep --no-textconv --no-recurse-submodules --full-name --no-color \
         -I -n -z -F [-i] -m <PER_FILE> -e <query> --untracked -- .
```

- `--no-textconv` — explicit, so no `.gitattributes` `textconv` a repo committed
  can make us run a program. It is the default, and it is stated anyway.
- `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=` — no repo hook, no
  fsmonitor daemon spawned. Same prefix `blob.ts` uses and for the same reasons.
- `-F` — **fixed strings only. No regex, ever.** This is the whole answer to
  ReDoS and to §7's "regex or DSL modifiers" rejection, in one flag.
- `-e <query>` — the query is never argv-positional, so a leading `-` is data.
  Verified: `-e '-foo'` matches the literal text.
- `-I` — never search binary files.
- `-z -n --full-name` — output is `path\0lineno\0content\n`. The path is
  NUL-terminated so a newline in a filename cannot forge a record, and `content`
  is a single line so it cannot contain `\n`. Verified against git 2.55.0.
- `--untracked` — the corpus becomes tracked **plus** untracked-not-ignored,
  which is exactly the finder's corpus
  (`ls-files --cached --others --exclude-standard`,
  `packages/core/src/git/status.ts:563`). Verified: `--untracked` honors
  `.gitignore`; only `--no-exclude-standard` would break that, and we never pass
  it.
- `--no-color` — a repo-local `color.grep` config cannot inject SGR into the
  payload.
- `-i` — added by us **only when the query contains no uppercase letter**. That
  is smart-case, implemented here rather than borrowed, because git grep has no
  smart-case mode. Same rule the finder already uses.

#### Bounds

Every one of these is a named constant in `grep.ts`, and every one is asserted by
a test.

| Constant | Value | What it stops |
|---|---|---|
| `GREP_MIN_QUERY` | 3 | a one-character query scanning the whole tree on every keystroke |
| `GREP_MAX_PER_FILE` | 20 (`-m`) | one generated file dominating the result set |
| `GREP_MAX_RESULTS` | 500 | an unbounded response body |
| `GREP_MAX_BYTES` | 4 MiB | an unbounded buffer; the child is killed at the cap |
| `GREP_TIMEOUT_MS` | 5000 | a wedged git holding a request open |
| `GREP_MAX_LINE_CHARS` | 400 | a minified bundle line reaching the DOM |
| `GREP_CONCURRENCY` | 2 | git process pile-up |
| `GREP_QUEUE_LIMIT` | 16 | an unbounded waiter list |

Concurrency reuses `createBlobSemaphore` (`packages/daemon/src/blobSemaphore.ts:57`)
with its own limits — one semaphore for the whole daemon, not one per router,
same reasoning as the blob gate (`server.ts:199`). Over the queue limit is a 503,
not a wait.

Cancellation is a hard requirement, not an optimization: the client debounces and
the daemon kills the previous child for the same repo when a new query arrives.
A killed child's partial output is discarded, never returned.

#### Decoding — the non-UTF-8 hazard, handled

stdout is read as `Buffer`. Records are split on `\n` at the byte level, then each
field is decoded with a non-fatal `TextDecoder('utf-8')`, so invalid bytes become
U+FFFD instead of corrupting the parse. **Match offsets are re-found in the
decoded string**, not carried from byte offsets — git grep does not report offsets
anyway, and re-finding is what guarantees the highlight is always consistent with
the text actually rendered. A result whose decode introduced replacement
characters carries `lossy: true`, and the UI says so on that row rather than
showing silent mojibake.

Lines longer than `GREP_MAX_LINE_CHARS` are windowed around the first match and
carry `clipped: true`.

#### Security

**The route is `POST`, not `GET`, and that is the whole answer to §7's timing
oracle.** `guardRequest` (`packages/daemon/src/security.ts:155-156`) treats
GET/HEAD/OPTIONS as non-mutating and returns early — GETs are CSRF-exempt by
design. A `POST` goes through the `Sec-Fetch-Site` and `Origin` checks, and a
JSON body triggers CORS preflight besides. A cross-site page can no longer issue
the request at all, so a repo id that is `sha256(worktreeRoot).slice(0,12)` and
computable offline stops being an oracle. Write that sentence into the route's
module header, because "a read should be a GET" is exactly the refactor that
would silently reopen it.

Registered in **both** api modes: the web UI is its only consumer, and a `--port`
daemon is precisely the one that needs it (same reasoning as the blob routes,
`server.ts:219-222`).

Paths in results are repo-relative and produced by git, but every path the client
sends back on activation still goes through `requireRepoRelPath` +
`requireRealRepoPath` on `/file`, unchanged. The grep route itself takes no
client path at all — the pathspec is a literal `.`.

#### Endpoint

```
POST /repos/:id/search
  body: { query: string, limit?: number }
  200:  {
    query: string,
    smartCase: boolean,
    files: Array<{
      path: string,
      matches: Array<{ line: number, text: string, start: number, end: number,
                       lossy?: boolean, clipped?: boolean }>,
      capped: boolean          // hit GREP_MAX_PER_FILE
    }>,
    total: number,
    truncated: null | 'results' | 'bytes' | 'time'
  }
  400: query shorter than GREP_MIN_QUERY
  503: the grep queue is full
```

`truncated` is a discriminated reason, never a bare boolean. "500 results, there
are more" and "we ran out of time" are different sentences to a user and must not
share a string. Reuse `optionalIntField` / `requireStringField`
(`routes/shared.ts`) for the body.

**Exit codes:** `git grep` exits 1 on no matches, which is not an error. Only a
non-zero-and-not-1 exit is a 500.

#### Client

`packages/client/src/client.ts` gains
`search(id: string, query: string, opts?: { limit?: number }): Promise<SearchResults>`.
No wire decoder — no Dates, no Maps.

#### Web UI

**Layer: the existing modal overlay slot.** `OverlayName` (`stores/ui.ts:32`)
gains `'search'`, a sibling of `'finder'` and `'help'`, rendered by the same
`v-if`/`v-else-if` chain in `App.vue` so at most one is ever open. No new layer,
no sixth view, nothing in the URL. Section 3's rejections of the dock and the
rail view stand unchanged, and its reason for rejecting the rail view — "a query
is a filter over an existing set, not a place" — is why this is transient.

New `components/SearchOverlay.vue`, modelled on `FinderOverlay.vue`:

- session state only, never persisted (`stores/ui.ts` header rule);
- a repo switch while it is open **closes it**, copying
  `FinderOverlay.vue:96-100` verbatim — a result list captured for one repo must
  not survive a follow-mode switch;
- the shared `FINDER_DEBOUNCE_MS` is too fast for a network round trip; use a
  separate `SEARCH_DEBOUNCE_MS = 150` in `core/view/finderModel.ts` next to it,
  and a module-scoped generation guard so an out-of-order response is dropped;
- results grouped by file, keyboard-navigable with `clampMove`/`cycleMove` from
  `finderModel` — the fourth consumer of §5.1;
- **honest copy on every state**: "no matches", "showing the first 500 of more",
  "stopped after 5s", "query too short", "search is busy", and the per-row
  "this line has bytes we could not decode". Never one string for two states.

**Activation** reveals the file in the Explorer at the matched line:
`explorer.revealFile(path)` — the finder's existing path
(`FinderOverlay.vue:135`) — then scroll to the line. `FileContentPane.vue` renders
every line with `data-ln="N"` and uses `content-visibility: auto` rather than
windowed virtualization (`FileContentPane.vue:166-169,300`), so
`querySelector('[data-ln="N"]')` always exists and `scrollIntoView` always works.
No new virtualization machinery.

**Scroll-to-line is a shared prerequisite, and it is the reason to build it
first.** The symbol popover needs exactly the same gesture. Build one seq-stamped
one-shot request ref on the explorer store — the same trick `stackScrollRequest`
(`stores/ui.ts:156-162`) uses, and for the same reason: a plain value ref is inert
the second time the same line is requested — consumed by `FileContentPane`, with
a brief row flash reusing the existing flash token.

**Match colour.** If a match run is painted inside a code row it needs its own
token (`--match-bg` / `--match-fg`) per theme. Do **not** reuse `--warn`: it was
tuned for WCAG AA against chrome backgrounds, and in `dark-ansi` the code
background is raw ANSI while `--warn` is `#cdcd00`. The two colorblind themes
exist because hue-only signalling fails there, so the run needs a non-colour
signal too. Check all six by hand.

#### Tests

Core (`grep.test.ts`, real temp repos, no mocks): a match in a tracked file; a
match in an untracked-not-ignored file; **no** match in a gitignored file; binary
skipped; a query with a leading `-` treated as text; a query with regex
metacharacters matched literally; smart-case both directions; a filename
containing a newline parsed correctly; a file with invalid UTF-8 decoded lossily
with `lossy: true` and correct offsets; `-m` capping per file with
`capped: true`; each `truncated` reason; exit code 1 is not an error; a killed
child returns nothing rather than partial output.

Daemon: `POST` is guarded and a cross-site `Sec-Fetch-Site` is a 403; the route
exists in both api modes; a short query is a 400; a full queue is a 503; a second
query for the same repo cancels the first.

Web: overlay opens on both keys and closes on both; the repo-switch close; the
generation guard drops a stale response; each empty/truncated state renders its
own string; activation calls `revealFile` and requests the right line.

### 10.3 Sequencing

Smallest slice that delivers real value first, then the rest. §5.1 to §5.4 are
**already shipped** (finder model, CLI Ctrl+C, `/files` invalidation, bare `e`)
and §5.6 has landed (bare `/`, `stores/filter.ts`, `useTextFilter.ts`,
`FilterChip.vue`), so every prerequisite below is already met.

**Slice A — the git attributes flag. One commit, one flag, ships alone.**
`-c core.attributesFile=<bundled>` in `gitClient.ts:38` plus the bundled
attributes file and its driver-verification test. It improves every `@@` hunk
header in both UIs today, for 28 languages, and is independent of everything
below. Measured +50 points on Python. If nothing else in this plan ever gets
built, this still should.

**Slice B — scroll-to-line.** The seq-stamped one-shot request on the explorer
store plus `FileContentPane` consuming it, with a row flash. Perhaps 80 lines. It
is a prerequisite for both features, it is testable on its own, and it is the
reason to do it before either.

**Slice C — global text search, end to end.** `core/git/grep.ts`, the
`POST /repos/:id/search` route, the client method, `SearchOverlay.vue`, both
keybindings, `HotkeysOverlay.vue`, `FEATURES.md`, `CHANGELOG.md`. This is the
first slice a user feels, it is entirely conventional engineering, it adds zero
new dependencies and zero tarball weight, and it answers the half of the request
the author called out as primary ("getting this functionality into the web ui").
**Ship this before touching tree-sitter.**

**Slice D — symbols, engine only, no UI.** `core/symbols/*` with the TypeScript
query and the Vue `includedRanges` scanner, the vendored grammars with checksums,
`symbols=1` on `/file`, the client argument, the `/version` capability field, and
the golden fixtures. Verifiable entirely by tests. The tarball grows here, so this
is the slice where the CI tarball-boot gate earns its keep.

**Slice E — the outline popover on bare `o`**, absorbing §5.5. It reuses slice B's
scroll-to-line and slice D's endpoint, so it is mostly a component.

**Slice F — JavaScript and Java queries.** Half a day each, plus fixtures. Pure
onboarding through the seven steps; nothing structural changes.

**Slice G — the CLI**, when the CLI is un-demoted. Bare `o` and bare `F`, both
against endpoints that already exist. No engine code in the CLI, by construction.

Amend `docs/feature-review-0.9.0.md` §4 and §6 in the same commit as slice A:
record that the trigger fired, what was lifted, and what stayed rejected. Section
6 item 8 already asked for this and it is still the cheapest documentation change
available.

### 10.4 Risks

**These have NOT been adversarially reviewed.** The review pass that section 5's
designs went through did not run for section 10 — it failed on a scripting bug,
and the list below is the designers' own account of their risks, not a verdict
that survived attack. Treat it as unaudited until the security, layering and
value-for-cost passes have actually been done. That is tracked as slice 0.

1. **The freeze is now open, and that is the standing risk.** Section 6 risk 1
   said cheap is exactly how frozen features get built early. Two rejections were
   lifted and the other nine were not. Every future "while we're in here" against
   this code is a new decision needing its own trigger, not an extension of this
   one. Guard it in review.
2. **Tarball weight is real and permanent.** 224,779 B compressed today becomes
   roughly 538 KB. That is the price of correctness, and it was accepted with the
   numbers in front of us — but it is a floor, not a ceiling: every added language
   moves it. The bounded language set is the mechanism that keeps it from
   drifting, and it only works if step 3 of the onboarding recipe is actually
   enforced.
3. **A wrong symbol label is the failure that discredits the feature.** That is
   why an unmappable context (staged-vs-HEAD, compare base, history) degrades to
   hunk-only, why a null enclosing symbol renders blank and never as the nearest
   guess, and why a scanned symbol and git's `@@` text never share a column.
4. **The status union collapsing.** Six states, six strings. This is the most
   likely way the feature becomes quietly wrong, and it will happen through an
   innocent-looking simplification in a Vue template, not through a design change.
   Test each string.
5. **`workingDiffs` is cold until Changes has been activated once**
   (`stores/repo.ts:687,1038`, risk 5). Unchanged and still true. The outline is
   built from the `/file` read specifically so this cannot bite; anything that
   later moves it to `workingDiffs` reintroduces a silent zero-result bug.
6. **Hunk identity** (risk 3). `hunkKeyFor` hashes the `@@` context
   (`web/src/utils/diffRows.ts:224`). Nothing in this plan touches
   `parseHunkHeader`, and nothing should. The golden hunk-key stability test stays
   mandatory. The attributesFile graft in slice A changes the funcname **text**
   git produces for some languages, which does not touch `hunkKeyFor`'s inputs on
   any diff already rendered — but it does mean hunk keys computed before and
   after the upgrade differ for those languages. That is a one-time reload, and it
   must be checked against the golden test, not assumed.
7. **The unbounded git client is still unbounded.** `gitClient.ts:38` gained no
   timeout and no `maxBuffer` in this plan; grep simply does not use it. Every
   other caller still does. That is a pre-existing hazard this work leaves exactly
   where it found it, and it is worth its own fix on its own trigger.
8. **The `POST`-not-`GET` decision is load-bearing and non-obvious.** A future
   refactor "correcting" a read to a GET reopens the CSRF-exempt timing oracle in
   §7. The reason belongs in the route's module header, and a test should assert
   the method.
9. **Non-UTF-8 output.** Handled by decoding lossily and re-finding offsets in the
   decoded string, but the hazard is permanent: any future code that reads grep
   output as a string before splitting reintroduces it.
10. **The deadline is a real state, not a theoretical one.** A minified bundle or
    a high-entropy blob that slips past the NUL scan will hit it. It must render
    as "outline unavailable", never as an empty list.
11. **Lint budget** (risk 6). 0 errors, 20 warnings. A search overlay with six
    empty states and a popover with six status strings are exactly the shape that
    trips sonarjs cognitive-complexity. Keep the decisions in small pure functions
    in `core/symbols/mapping.ts` and `core/view/`, which is also what makes their
    caps testable without mounting anything.
12. **Grammar ABI drift.** A `web-tree-sitter` bump can stop loading a vendored
    grammar. The pin is exact and a startup test loads every shipped grammar, so
    this fails in CI. Without that test it fails in a user's terminal.
13. **The Vue `includedRanges` scanner is ours and has no upstream.** It works on
    all 29 files here, but an SFC feature it does not know about (a `<script>`
    variant, an unusual attribute order) degrades to "no symbols" rather than to
    wrong symbols. That is the right direction to fail, and it needs fixtures.
14. **Follow mode taking the viewport** while the search overlay or the outline
    popover is open (risk 4). Decided in both places above — close, do not fight
    the view switch — and it needs the `useFollowMode.test.ts` cases to actually
    be written.
