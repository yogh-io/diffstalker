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

**Post-review note (2026-08-06).** Three blockers in §10.4 land on this section
and must be resolved before slice D starts. **B3**: a cancelled parse poisons the
shared parser, and `reset()` does not reliably cure it — so "No worker thread in
v1" is withdrawn. **B4**: the 50 ms deadline bounds parse only; query execution is
unbounded and measured at 2.4 s on a 32 KiB file, so the "50 ms ceiling" claim is
wrong. **B5**: the `.scm` queries and the emscripten runtime `.wasm` can never
reach a built or published daemon as specified. Items 25 to 34 also correct this
section (no concurrency gate, eager parsing, wasm memory lifetimes, the singular
Vue scanner, the cap mismatch, the oversized status union, the staged-side
degrade, the `/version` probe, and the missing dependency-cruiser rules). Nothing
above has been rewritten around them — read §10.4 first.

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

**Post-review note (2026-08-06).** Two blockers in §10.4 land on this section and
must be resolved before slice C starts. **B1**: `grep.column` adds a fourth
NUL-delimited field, so the pinned output shape is wrong and the argv needs
`--no-column`. **B2**: the stated parse order is wrong — records must be read
NUL-first, never split on `\n` first — and `-I` is not the binary bound the caps
table claims, because content can carry raw NUL. Items 15 to 24 and 34 also
correct this section (no query cap, no semaphore withdrawal, a request-level
deadline, per-client rather than per-repo cancellation, the two meanings of
"killed", the missing scroll target past 5,000 lines, no `state-change`
invalidation, the false preflight claim, unspecified child plumbing, offsets
disagreeing with git's matcher, and the untested symlink case). Nothing above has
been rewritten around them — read §10.4 first.

### 10.3 Sequencing

Smallest slice that delivers real value first, then the rest. §5.1 to §5.4 are
**already shipped** (finder model, CLI Ctrl+C, `/files` invalidation, bare `e`)
and §5.6 has landed (bare `/`, `stores/filter.ts`, `useTextFilter.ts`,
`FilterChip.vue`), so every prerequisite below is already met.

**Slice A — the git attributes flag. SHIPPED.** `core.attributesFile` plus
`timeout: { block: 10000 }` (finding 37) in `packages/core/src/git/gitClient.ts`,
generated by `packages/core/src/git/diffAttributes.ts`, verified by
`diffAttributes.test.ts` against real git.

Two corrections to what this section originally claimed, both measured:

- **The attributes file is GENERATED, not bundled.** A shipped asset hits
  finding B5 exactly as the `.scm` files do: core compiles with plain `tsc` and
  is bundled into the daemon as one file, so a non-TS file beside the source
  survives neither step. It is a string constant written to the cache dir on
  first use instead, which needs no build or packaging change. Anything else
  slice D wants to ship has the same problem and needs a real answer, not this
  workaround.
- **It does nothing for TypeScript, JavaScript or Vue** — so "improves every
  `@@` hunk header, for 28 languages" was wrong. git ships no driver for those
  languages, and an unknown `diff=typescript` is ignored silently rather than
  refused. Borrowing another language's driver does not work either: `java`,
  `cpp` and `csharp` were each tried against `render(): number {` and all three
  returned the same useless `export class Widget {` as the default. Pinned as a
  test so it is not re-attempted. This repo's own code therefore gains nothing
  here; the Aerius Java repos and any Python gain a lot.

Verified: python `class Widget:` -> `def render(self):`, java
`public class Widget {` -> `public void render() {`, plus ruby, go and rust. A
repo's own `.gitattributes` still wins — this is the lowest-priority source.

Known and accepted (finding 36): this changes the funcname text for the affected
languages, which re-keys their hunks. No golden test detects it, and the
observable effect is one lost scroll position after upgrade.

**Slice B — scroll-to-line. SHIPPED.** `lineRequest` (seq-stamped) on the
explorer store, `revealFile(path, { line })`, and `FileContentPane` consuming it
by `data-ln` with a fading flash — no second source of truth for line positions.

**Slice B (as originally written) —** The seq-stamped one-shot request on the explorer
store plus `FileContentPane` consuming it, with a row flash. Perhaps 80 lines. It
is a prerequisite for both features, it is testable on its own, and it is the
reason to do it before either.

**Slice C — global text search. SHIPPED.** `core/git/grep.ts`,
`POST /repos/:id/search`, client methods, `SearchOverlay.vue`, Ctrl/⌘+Shift+F and
bare `F`. Blockers B1 and B2 were fixed before the parser was written and both
are fixtures now (`--no-column`; NUL-first parsing; NUL-in-content dropped as
binary). Verified in a browser end to end.

**Slice C (as originally written) —** `core/git/grep.ts`, the
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

**Post-review note (2026-08-06).** The slice order still holds, but two slices
cannot start as written. Slice C is blocked on **B1** and **B2** in §10.4 (the
grep argv and the record parser). Slice D is blocked on **B3**, **B4** and **B5**
(parser poisoning, the unbounded query, and artifacts that never ship) — B3 and
B4 together mean slice D includes a worker thread, which the design had deferred,
so budget for it. Slice A gains one key in the same commit (item 37: the git
client timeout) and one honest decision about the golden hunk-key test that does
not exist (item 36). Slice 0 — the adversarial review this section names — has now
run; its output is §10.4.

### 10.5 Packaging: grammars are a separate, opt-in package

**Decided 2026-08-06, overriding §10.4's vendor-into-diffstalkerd conclusion.**
Vendoring was right about WHAT to ship and wrong about WHERE. Measured, the
daemon is 200 kB packed / 598 kB unpacked today, and 512 kB of that unpacked is
the web UI. Adding 2.44 MB of wasm would make grammars the dominant payload of a
tool whose whole character is being small.

**The shape.** A new published package, `diffstalkerd-grammars`: grammar `.wasm`,
our `.scm` queries, the `web-tree-sitter` runtime `.wasm`, and `checksums.json`.
Pure data — no code, no dependencies, and above all **no install scripts**, which
is the property that disqualified the first-party grammar packages in the first
place.

**It is NOT a dependency of `diffstalkerd`, optional or otherwise.** A default
`npm i -g diffstalkerd` stays at 200 kB and grows by nothing. Outlines appear
after `npm i -g diffstalkerd-grammars`. Chosen over `optionalDependencies`
because an optional dependency installs by DEFAULT — it makes lean possible
rather than lean normal, which is the opposite of the point.

**Resolution.** `createRequire(import.meta.url).resolve(...)` against the
package, exactly how `chokidar`/`simple-git`/`ignore` are already externalled
(`packages/daemon/package.json:36`). Not installed resolves to nothing, which is
the same branch as a failed checksum: symbols off.

**No new `SymbolOutcome` variant, and this matters.** §10.4 item 30 warns against
the status union growing, and "the grammars package is not installed" is
INSTALL-level state, not per-file state. It is reported once through `/health`'s
extension list — already specified as derived from grammars actually present and
verified (item 32) — so an empty list means the engine is absent and the UI shows
one install hint. A partially installed set falls out of the same list for free.
Per-file, an extension not in the list is simply not offered an outline.

**ABI skew is the one new hazard.** The `web-tree-sitter` JS is bundled into the
daemon's worker; the runtime `.wasm` and the grammars now ship separately, so the
two can be upgraded independently. `diffstalkerd-grammars`'s `package.json`
declares the `web-tree-sitter` version it was built against; the daemon compares
it against its own bundled version at load and disables symbols with a specific
message on mismatch — never a silent degrade, and never a wrong symbol. The
load-every-grammar startup test (risk 12) still runs and still disables any
individual grammar that fails to compile its query.

**Release model.** This makes three published packages where CLAUDE.md commits to
two, all derived from the root version in lockstep. Mechanical, but it touches
`scripts/release.ts`, the CI publish job and CLAUDE.md, and those edits belong in
the same commit that first publishes the package.

**The CI tarball gate grows a second case**: install the daemon tarball alone and
assert `/health` reports an empty extension list and a `.ts` file offers no
outline; then install the grammars tarball and assert the same request returns
`status: "ok"` with a known symbol. Both halves, or B5 comes back wearing a
different hat.

### 10.6 Distro packaging, and where the grammars actually live

Three consequences of §10.5 that only surface once you read
`diffstalker-git`'s PKGBUILD.

**Arch users must never be told to `npm i -g diffstalkerd-grammars`.** The
PKGBUILD spends thirty lines on exactly why: npm's prefix on Arch is `/usr`, a
global install plants unowned files there, and pacman aborts the whole
transaction over them. The npm opt-in is for npm users. Arch gets a companion
`diffstalker-grammars-git` listed in `optdepends`, installing to a pacman-owned
path — the same opt-in shape, expressed in the distro's own terms.

**So resolution is a search order, not a single lookup.** In order:

1. `--grammars DIR`, or `DIFFSTALKER_GRAMMARS_DIR`. Explicit. The systemd unit
   sets it; the AUR package sets it; tests set it, which is what lets the whole
   engine be tested without npm in the loop.
2. `createRequire(import.meta.url).resolve('diffstalkerd-grammars/...')`.

Two first-class sources, both documented — not a primary path with a fallback
under it. Nothing is silently attempted after something failed: an explicit
directory that does not verify disables symbols and says so, rather than
quietly trying npm resolution next.

**`packages/grammars` is a workspace package named `diffstalkerd-grammars`.**
That is what makes step 2 resolve identically in dev (bun links workspace
packages into `node_modules`) and after a real npm install. Without it, dev
would need its own lookup and the no-prod/dev-divergence rule would be broken by
the packaging itself.

**The `.wasm` files are NOT committed to git.** The repo is 6.3 MB with a
4.76 MiB pack; 2.44 MB of grammars is about +50%, permanently, on every clone —
and `diffstalker-git` is a VCS package, so every AUR user pays it on every
build. Instead `bun run vendor:grammars` pins versions and sha256s and fetches
at build time.

This does not weaken §10.5's offline-reproducibility argument, which was about
the published TARBALL not needing network at install: the npm package still
contains the wasm. Build time already requires network for `bun install`, so
nothing new is divergent. It also gives the AUR package the shape Arch expects —
a `source=()` array with `sha256sums`, fetched and verified by makepkg itself
rather than by a script we wrote.

**Consequence for CI:** the grammars package is built by the release pipeline
(vendor, then publish), so the vendor script is release infrastructure, not a
developer convenience. It needs the same treatment as the tarball-boot gate:
if it silently fetches the wrong version, every outline is subtly wrong, so the
checksums are the gate and a mismatch must fail the build loudly.

### 10.4 Risks

The adversarial review ran on 2026-08-06, late, before implementation started.
Four lenses attacked this section: grep security, symbol-engine security,
layering, and value-for-cost. Every claim below was re-checked against the real
source or reproduced against real tooling before it was written down. Claims that
did not reproduce were dropped and are named at the end, so nobody re-derives
them.

No lens came back empty. Five blockers survived verification.

#### Blockers — these must change before any code is written

**B1. `git grep` emits a fourth field when `grep.column` is set, and the design's
argv does not stop it.** The §10.2 Engine section pins the output shape as
`path\0lineno\0content\n` and calls it verified. It is only that shape when
`grep.column` is false. `grep.column=true` is a documented git config, settable
in `~/.gitconfig` or in a repo's own `.git/config`, and it inserts a
NUL-delimited column field: `path\0lineno\0column\0content\n`. Reproduced on git
2.55.0 with the design's exact argv. The parser then reads the column number as
the line content, silently, for every query, with no error anywhere. Follow mode
opens repos automatically from a hook file, so the repo-local variant needs no
click. **Fix:** add `--no-column` to the argv, next to `--no-color` and for the
identical reason (verified to override `grep.column=true`). Add a core test that
runs the whole grep under a hostile config
(`-c grep.column=true -c grep.lineNumber=false -c grep.fullName=false
-c grep.patternType=perl`) and asserts byte-identical parsed output. The other
`grep.*` keys are already neutralised by the explicit flags — `-F` was verified
to beat both `grep.patternType=perl` and `grep.extendedRegexp=true`, so the ReDoS
answer holds.

**B2. The stated record parser is wrong twice: it splits on the wrong byte first,
and `-I` is not the binary bound it is claimed to be.** §10.2 Decoding says
"Records are split on `\n` at the byte level", one sentence after saying a
newline in a filename cannot forge a record. Those contradict each other.
`git grep -z` emits a raw newline inside a path; reproduced with a file named
`we\nird.txt`, whose record is `w e \n i r d . t x t \0 1 \0 has alpha here \n`.
Splitting on `\n` first shreds it into two garbage records — so the design's own
test ("a filename containing a newline parsed correctly") would fail against the
design's own algorithm. Separately, `content` can contain raw NUL, both verified:
git's binary sniff only inspects the first 8000 bytes, so a file whose first 8100
bytes are ASCII and whose matched line is `alpha\0\0PWNED` is searched as text and
emitted verbatim; and a committed `.gitattributes` line `binary.bin -text diff`
makes `-I` search a genuinely binary file (`binary.bin\0 1\0 \0\x01bin alpha\0after\n`).
There is no git flag that disables in-tree `.gitattributes`. **Fix:** parse each
record NUL-first — from the cursor, `indexOf(0)` for the path, `indexOf(0)` for
the lineno, then to the next `\n` for the content, and only then decode the three
slices. Never `split('\0')` and never split on `\n` first. Write that order into
the module comment as the reason, because "split the buffer into lines" is the
obvious refactor that reintroduces it. Then reject any record whose content
contains a NUL as binary — git was wrong about the file — and state in the module
header that `-I` is advisory and the parse layer is the real binary bound. The
precedent is already in the repo: `packages/core/src/git/blob.ts:200-209` compares
NUL-delimited records as BYTES for exactly this reason. Add both fixtures to
`grep.test.ts`. Note for slice G: the content field is arbitrary repo bytes — C0
controls and ESC sequences included — and `GREP_MAX_LINE_CHARS` is a length cap,
not a sanitizer. §5.1 already records that unescaped content corrupts a blessed
`tags: true` box.

**B3. A cancelled parse poisons the shared parser, and `reset()` does not reliably
cure it.** §10.1.2 enforces `SYMBOL_DEADLINE_MS = 50` through `parse()`'s
`progressCallback` and specifies process-lifetime engine objects, so one `Parser`
serves every request. web-tree-sitter's own typings say the rest of the contract:
"If the parser previously failed because of a callback, then by default, it will
resume where it left off on the next call to parse... you must call `reset`
first" (`web-tree-sitter.d.ts:194-203`). The design never mentions `reset()`.
Reproduced against the exact versions §10.1 names (web-tree-sitter 0.26.11,
tree-sitter-typescript 0.23.2): after a 50 ms deadline cancel, parsing a
31-character valid file on the same parser returns a tree with
`endIndex=102774` carrying the previous file's content — symbol names and line
numbers from a different file, attributed to this one — or throws
`RuntimeError: memory access out of bounds` from inside wasm. And `reset()` is
not a cure: after cancelling an 80 KB `{a:`-nested file, `reset()` followed by a
good parse still threw `memory access out of bounds`. This is not exotic input: a
Qt Linguist translation file uses the extension `.ts`, maps to the TypeScript
grammar under `EXTENSION_TO_GRAMMAR`, and hits the deadline. If the throw lands
outside a `try`/`catch`, `packages/daemon/src/index.ts:379-380` turns it into
`process.exit(1)` and the daemon dies for the TUI and the browser at once. If it
is caught, §10.1's rule that failures become `{status:'unavailable'}` masks a
corrupt wasm module that keeps answering. This defeats the design's own headline
rule — a wrong line number is worse than a missing symbol — and it is caused by
the mechanism the design leans on. **Fix:** run the extractor in a
`node:worker_threads` worker that is terminated and respawned on cancel or throw.
§10.1.2's "No worker thread in v1 — the 50 ms ceiling makes one unnecessary" rests
on a premise that is false, and is withdrawn. Treat any `RuntimeError` from parse
or query as "this wasm instance is dead": discard the whole emscripten instance,
never merely return `unavailable`. Add the missing test: cancel a parse with a
0 ms deadline, then parse a golden fixture and assert its exact symbol list. The
design's deadline test only asserts `unavailable` on the cancelled request and
would pass while every subsequent request is wrong.

**B4. The 50 ms deadline bounds parse only. Query execution is unbounded and is
the real worst case.** Extraction has three phases — `Language.load`, `parse`, and
running the `.scm` query — and the design bounds one. `Query.captures` takes its
own options object with its own `progressCallback` and `matchLimit`; the parse
deadline has no effect on it. Measured on a 32 KiB file of `{` repeated: parse
completes in 22.1 ms, under budget, so the design's only guard never fires — then
`query.captures` runs for 2,392 ms and returns 0 captures. Adding a query
`progressCallback` does not fix it: with a 50 ms query deadline the same file took
1,231 ms, and `matchLimit=256` took 1,223 ms, because the callback is consulted at
coarse intervals. The daemon is single-threaded, so that is the whole process
blocked: SSE keep-alives (`packages/daemon/src/sse.ts:93`), follow mode, every
other repo, both clients. The 1.92 ms/file figure in §10.1.1 was measured over
this repo's ~250-line sources; it does not extrapolate to the 512 KiB cap the
design admits. **Fix:** stop calling 50 ms the feature's ceiling — it is a
parse-phase ceiling. Budget the whole extraction with one deadline across
`Language.load`, parse and query, give the query its own `progressCallback` and
`matchLimit`, and — because even a bounded query overshoots by more than a second
— enforce it out of process: the same worker from B3, killed by a wall-clock timer
the worker cannot block. Add a benchmark test with adversarial fixtures (a file of
`{`, a single 256 KB line, deep `() =>` nesting, a Qt-Linguist-shaped XML named
`.ts`) asserting a wall-clock ceiling, not a status value.

**B5. Two of the artifacts this feature needs can never reach a built or published
daemon.** Both verified.

- **The `.scm` queries.** §10.1.2 puts them at
  `packages/core/src/symbols/queries/<lang>.scm`, with no packaging recipe. Core's
  build is `"build": "rm -rf dist && tsc"` (`packages/core/package.json:15`) — tsc
  emits JS and d.ts only, so a `.scm` never lands in `packages/core/dist/`.
  `packages/core/src` contains zero non-TypeScript files today, so there is no
  asset-copy step to piggyback on. Then `bun build dist/index.js --minify --target
  node` (`packages/daemon/package.json:34`) inlines core's JS into
  `packages/daemon/dist/index.js`, so any `new URL('./queries/x.scm',
  import.meta.url)` resolves to `packages/daemon/dist/queries/x.scm`, a path that
  has never existed. The grammar half is safe only because `grammarDir` is
  injected by the daemon; the query half is not.
- **The emscripten runtime `.wasm`.** §10.1.1 charges 81,111 B for "runtime" and
  §10.1.2 says to load it with `Parser.init({ wasmBinary: fs.readFileSync(...) })`
  — from where is never stated. `web-tree-sitter` is a devDependency, so a global
  install of `diffstalkerd` has no `node_modules/web-tree-sitter/`. The vendoring
  recipe, `checksums.json` and the `"files"` addition all name language grammars
  only, and `packages/daemon/package.json:19-26` lists `dist/index.js`,
  `dist/web`, `bin` and three md files — nothing else.

**Fix:** treat a query as half of a language artifact, not as source. Put
`queries/*.scm` and the runtime `tree-sitter.wasm` next to the grammars in
`packages/daemon/grammars/`, checksum all of them, add the directory to `"files"`,
and inject a `queryDir` alongside `grammarDir`. Resolve the directory internally
from `import.meta.url` with a `copyGrammars.ts` step mirroring
`packages/daemon/scripts/copyWebDist.ts`, so dev, source-build and tarball resolve
identically — this repo's rule is no prod/dev divergence. Extend the CI
tarball-boot gate (commit `e0a3253`) to make a real `symbols=1` request against
the packed tarball; that is the only thing that would have caught either half. The
alternative worth weighing once, and only once: make the grammars pinned exact
runtime dependencies of `diffstalkerd` and resolve them with
`createRequire(import.meta.url).resolve(...)`, the way `chokidar`, `simple-git` and
`ignore` are already externalled at `packages/daemon/package.json:36`. That
deletes steps 1 and 2 of the onboarding recipe, the checksum test and risk 2 — but
it also gives up offline reproducibility, which is why the design chose vendoring.
Decide it explicitly rather than by default.

#### Confirmed defects — fix each in the slice that introduces it

These are real and verified, but none of them invalidates a design decision.

15. **The grep query has no cap at all.** §10.2 says every bound is a named
    constant asserted by a test, but the table has no cap on the one value the
    client fully controls. `requireStringField`
    (`packages/daemon/src/routes/shared.ts:53-66`) checks type and non-emptiness
    only, and the body limit is 1 MiB (`packages/daemon/src/router.ts:29`).
    Verified on node 24: a 200,000-char pattern makes `spawn` throw `E2BIG`
    synchronously, and a query containing a NUL throws
    `ERR_INVALID_ARG_VALUE`. Both are client-triggerable 500s with a stderr line
    each. Add `GREP_MAX_QUERY_BYTES`, and reject NUL and newline in the query with
    a 400, inside `grep.ts` so the bound holds for every caller. Also:
    `optionalIntField` (`shared.ts:98-110`) takes only `{min, fallback}` and
    cannot express an upper bound, unlike `parsePositiveIntParam`
    (`shared.ts:141-157`), which has `max` for precisely this reason — so
    `{query, limit: 1e9}` as specified validates. Clamp `limit` to
    `GREP_MAX_RESULTS`.

16. **The semaphore has no cancellation path, and the design's own per-repo kill
    is what leaks slots.** `createBlobSemaphore`
    (`packages/daemon/src/blobSemaphore.ts:83-92`) has no way to withdraw a queued
    waiter: `acquire()` returns a promise that is only ever resolved, and
    `makeRelease` hands the slot straight to the next waiter without decrementing
    `active`. Abandoning an awaited promise — exactly what "kill the previous
    child for the same repo" does when the previous request is queued rather than
    running — leaves a slot taken forever. With `GREP_CONCURRENCY = 2` that is two
    leaks before search is wedged for the life of the daemon. The design's whole
    treatment of the gate is one sentence about limits; it never mentions the
    slot-hold contract that `packages/daemon/src/routes/blob.ts:385-419` spends
    twenty lines of comment on (release wired to `res.finish`, `res.close` AND
    `req.close` because node and bun disagree about which fires on an abort; an
    idempotent release; a `requestIsOver` re-check after the await). Lift
    `holdSlot` into a shared module and use it verbatim. Model supersede as a
    per-repo generation token checked immediately after `acquire()` resolves —
    release the slot and return without spawning — never as a dropped promise. Add
    the leak test the blob routes already have.

17. **`GREP_TIMEOUT_MS` bounds the child, not the request, and nothing can
    withdraw a backlog.** The 5 s timeout starts when the child spawns. With 16
    queued behind 2 running, the last waiter starts after up to 8 × 5 s. The blob
    gate carries a 64-deep queue because its entries drain in milliseconds; grep
    entries are seconds each, so the same arithmetic means something completely
    different here and §10.2 reuses it without re-deriving it. The browser
    transport has no `AbortController` — `request()`
    (`packages/web/src/api/transport.ts:37-48`) builds its `fetch` init with no
    `signal` and takes no options — so closing the overlay or typing another
    character leaves every issued grep to run to completion. The 150 ms debounce
    and the generation guard drop stale responses; they do not stop the work. Make
    the deadline a request deadline: capture arrival time, and if the slot arrives
    with less than the remainder left, answer without spawning. Cut
    `GREP_QUEUE_LIMIT` to 4. Add an optional `AbortSignal` to the web transport's
    `request()` and abort the previous search on every new keystroke, so the
    daemon's cancellation can be driven by `req.close`.

18. **Per-repo cancellation is cross-client interference with no defined
    response.** Cancelling on repo identity rather than on the requester means any
    client's keystroke kills any other client's in-flight search of the same repo.
    One refcounted handle is shared by every client of a repo
    (`packages/daemon/src/repoRegistry.ts:132-173`); two browser tabs is the
    ordinary case, CLI + web on one repo is the shipped architecture, and follow
    mode opens repos across clients automatically. The endpoint defines exactly
    three outcomes — 200, 400, 503 — so a request whose child was killed by someone
    else either hangs or returns an empty 200, which renders as "no matches". That
    is the collapse §10.2 forbids two paragraphs later ("Never one string for two
    states"). Cancel on the requester's own disconnect (`req.once('close')`),
    driven by the client-side abort in item 17; that is per-client by
    construction. A repo-keyed map of live children must also be torn down in
    `RepoRegistry.closeRepo` or it outlives the handle it references.

19. **"Killed" means two opposite things.** `GREP_MAX_BYTES` says the child is
    killed at the cap; six lines later, "A killed child's partial output is
    discarded, never returned." Together, hitting the byte cap returns zero results
    with `truncated: 'bytes'` — the honest word "we stopped" attached to a
    dishonestly empty list, which is what the `truncated` discriminant exists to
    prevent. Split the rule: superseded means discard everything; cap reached
    (bytes, results or time) means stop reading, kill, and return everything
    already parsed with the matching reason. Implementation shape matters: the
    `execFile` + `maxBuffer` pattern in `packages/core/src/git/blob.ts:161-174`
    rejects and drops stdout on overflow, which is right for a blob and wrong for a
    capped result stream. Use `spawn` with incremental parsing. Add a test
    asserting a byte-capped search returns a non-empty list.

20. **A grep hit past the 5,000-line preview has no scroll target.** §10.2 asserts
    that `querySelector('[data-ln="N"]')` always exists.
    `FileContentPane.vue:168-171` renders every line of what `/file` returned, and
    `/file` cuts at `MAX_DISPLAY_LINES = 5000` and refuses entirely over
    `MAX_FILE_SIZE = 1 MiB` (`packages/core/src/git/explorerData.ts:32,35`).
    `git grep` has no such caps. Activation then reveals a file whose pane holds
    lines 1-5000, or `tooLarge` with no content at all, and silently scrolls
    nowhere. This is the same truncation §10.1 handles meticulously for symbols.
    Make it a seventh honest state: after `revealFile`, compare the requested line
    against `file.totalLines` / `truncated` / `tooLarge` and say "match at line
    8,214 — past the 5,000-line preview".

21. **Search results have no invalidation against `state-change`.** §10.2
    specifies two staleness defenses: close on repo switch, and a generation guard
    for out-of-order responses. Neither covers the worktree changing while the
    overlay is open — an editor save, a stage, a branch switch — all of which the
    daemon already broadcasts over the per-repo SSE stream the web store consumes.
    Line numbers in a result are a snapshot at query time; after an edit,
    activation lands on the wrong line with no signal. §10.1 goes to real trouble
    to make the symbol path structurally immune to this exact class of drift.
    Stamp the result set with whatever the store advances on `state-change` and
    mark the list stale when it moves — one banner is enough. At minimum, re-verify
    on activation that the matched text is still on the claimed line, and fall back
    to revealing the file with no line jump rather than jumping wrong.

22. **The CORS-preflight half of the POST rationale is false.** `readJsonBody`
    (`packages/daemon/src/router.ts:116-139`) never looks at Content-Type: it reads
    the body on POST/PUT/PATCH and `JSON.parse`s whatever arrives. So an attacker
    page can send a `text/plain` simple request with a JSON body and no preflight,
    and the handler parses it happily. The conclusion survives — the
    `Sec-Fetch-Site`/`Origin` pair in `guardRequest`
    (`packages/daemon/src/security.ts:154-176`) does the actual work and does close
    the §7 oracle — but risk 8 mandates writing this rationale into the route's
    module header, and half of what would be written there is not true. Require
    `content-type: application/json` on bodied requests: one check in
    `readJsonBody`, which makes the claim true for every POST route at once and
    costs nothing (both shipped clients already send it,
    `packages/web/src/api/transport.ts:45` and
    `packages/client/src/transport.ts:182`). Add a daemon test for a `text/plain`
    body alongside the cross-site `Sec-Fetch-Site` one.

23. **Child-process plumbing is unspecified.** Three mechanical gaps next to a
    design that otherwise names every flag. `stdio` is never stated —
    `git grep` writes per-file warnings to stderr, and `blob.ts:444-447` pipes it
    nowhere on purpose ("a pipe nobody drains is a pipe git can block on
    forever"); `stdin` must be `ignore` for the same hygiene. The kill signal is
    unnamed; `blob.ts:483,497` uses SIGKILL because a wedged git must actually die.
    And only `GREP_MAX_BYTES` is documented as killing the child, while
    `GREP_MAX_RESULTS` is reached first in the common case. Specify
    `stdio: ['ignore','pipe','ignore']` and SIGKILL, kill at whichever cap trips
    first, and record which one in `truncated`.

24. **Re-found match offsets can disagree with git's matcher.** §10.2 re-finds
    offsets in the decoded string so the highlight is always consistent with the
    rendered text. That holds only when our matcher agrees with git's, and it does
    not for `-i`: every git child runs under `LC_ALL=C` / `LANG=C`
    (`packages/core/src/git/gitClient.ts:12-14`), so git folds ASCII only, while a
    JS re-find via `toLowerCase()` folds full Unicode. Verified: under `LC_ALL=C`,
    `git grep -i -F -e 'äpfel'` does not match `ÄPFEL`, while `-i -e 'strasse'`
    matches `STRASSE`. The decoder is also lossy by design, so a match spanning
    invalid bytes becomes U+FFFD and is not re-findable at all. Either way
    `indexOf` returns -1, and the response type declares `start` and `end` as
    required numbers. Make them optional and render the row unhighlighted when the
    re-find fails. Define smart-case as `/[A-Z]/` on the raw query — the ASCII test
    git can honour — and add a lossy-decode fixture asserting the no-offset path.

25. **Symbol extraction lands on the only ungated GET, and the design leaves it
    ungated.** "No new corpus" is true and is not the risk. The risk is that
    `/file` becomes the daemon's only synchronous CPU-heavy endpoint. The repo
    already reasoned this through for bytes:
    `packages/daemon/src/blobSemaphore.ts:1-30` explains the gate, and
    `packages/daemon/src/server.ts:199` creates one — but `server.ts:222` passes it
    only to `registerBlobRoutes`; `registerExplorerRoutes` at `:218` gets nothing.
    Symbols are worse than blobs on every axis the gate was built for: blob work is
    an async spawn or fd read, symbol work blocks the loop for its whole duration.
    Explorer routes are registered in both api modes, so `/file` is served on the
    loopback TCP port; `guardRequest` exempts every GET from the CSRF checks by
    design (`packages/daemon/src/security.ts:155-156`); and repo ids are
    `sha256(path).slice(0,12)` (`packages/daemon/src/repoRegistry.ts:25`),
    deterministic and guessable for `/home/<user>/gitRepos/<name>`. A page cannot
    read the responses, which is why nobody bounded this before; with symbols
    attached it does not need to. Gate the `symbols=1` branch only — never plain
    `/file` — behind its own `createBlobSemaphore(1, 4)`, answering 503 when full.
    Once B3 and B4 move extraction into a worker, the semaphore is the worker's
    inbox depth. Add a route test that fires N concurrent `symbols=1` requests and
    asserts `/health` still answers within a bounded time.

26. **Symbols get parsed on every file open, for a popover most opens never
    show.** §10.1.2 sets `fileSymbols` from the same fetch that sets `file`
    (`openFile`, `packages/web/src/stores/explorer.ts:344-362`). `openFile` has no
    debounce and no coalescing — only a client-side generation guard checked after
    the await, which discards the response the daemon has already paid for. Holding
    arrow-down through a directory issues one parse per keystroke. The design never
    decides whether `symbols=1` is always-on or on-demand, and its coherence
    argument ("one read, one truncation, one line numbering, no coherence race")
    only holds for always-on. Decide it: fetch symbols only when the outline opens,
    and have that one response set both `file` and `fileSymbols`. Coherence is then
    preserved by the response, not by the fetch's timing — write that in the store
    comment, because the response is what does the work. The 64-entry sha256 LRU
    makes a repeat free.

27. **web-tree-sitter has manual memory lifetimes and no finalizers.** `Tree`,
    `Query`, `Parser` and cursors are handles into the wasm linear heap and must be
    released with `.delete()`. The shipped 0.26.11 bundle contains zero occurrences
    of `FinalizationRegistry` (verified by grep), so nothing reclaims them when the
    JS wrapper is collected, and the emscripten heap only ever grows. §10.1.2
    specifies the extractor's caches in detail and never mentions releasing a tree,
    and it does not say what the 64-entry LRU holds. RSS moved from ~67 MB to
    ~130 MB across a handful of adversarial parses and stayed there. For a daemon
    designed to outlive the TUI and stay warm, that is a permanent regression no
    restart-free deployment recovers from. State the lifetime rule in the module
    header: parse and query inside `try`/`finally` that always calls
    `tree.delete()`; compiled `Query` objects are the only long-lived handles.
    Specify that the LRU stores plain `FileSymbol[]` — strings and numbers only,
    never a `Node`, a `QueryCapture`, or anything reading `.text` lazily. That is
    also what makes the sha256 key sound. Add a soak test with an RSS ceiling.

28. **The Vue scanner is specified as singular and this repo already breaks it.**
    §10.1.1 describes a ~12-line scanner that finds "the `<script>` block bounds".
    Three `.vue` files here have two script blocks —
    `packages/web/src/components/DiffStack.vue` (`<script lang="ts">` at line 1,
    `<script setup lang="ts">` at line 151), `packages/web/src/dev/DiffChurnHarness.vue`
    and `packages/web/src/views/JournalView.vue`. `<script>` plus `<script setup>`
    is the ordinary Vue 3 shape, not an edge case. Emit ranges for ALL script
    blocks — `includedRanges` takes an ordered non-overlapping array. Also give the
    scanner its own outcome: when no script block is positively identified
    (opening tag AND closing tag AND non-empty body), return
    `unsupported: 'no-script-block'` with its own string, never an empty `ok`.
    Fixtures should be adversarial, not representative: `<script>` inside a comment
    and inside template text, no closing tag, two blocks, lang absent, `lang="js"`,
    CRLF, and a non-ASCII prefix (indices are UTF-16 code units). Minor correction
    while here: the repo has 30 `.vue` files today, not the 29 §10.1.1 counts.

29. **`SYMBOL_MAX_BYTES` (512 KiB) sits below the display cap (1 MiB), so the
    mandated "too-large" copy is false in the band between them.** The status table
    says `unsupported: 'too-large'` means "there is no content at all".
    `readFileForDisplay` refuses text only above `MAX_FILE_SIZE = 1 MiB`
    (`packages/core/src/git/explorerData.ts:32`). For a 700 KiB text file the pane
    shows the full content while the outline says there is none — two different
    caps sharing one word, which is risk 4's collapse baked into the design rather
    than introduced later. The design also does not say whether the cap is measured
    against the file's size or against the possibly-truncated content actually
    parsed. Align the symbol cap to the display cap, or split the outcome into
    `no-content` and `too-large-to-outline` with distinct copy. Either way, state
    that the cap is measured against the content string that is actually parsed.

30. **Three of the six `SymbolOutcome` states duplicate flags the same response
    already carries.** `FileForDisplay`
    (`packages/core/src/git/explorerData.ts:84-95`) already has `binary`,
    `tooLarge`, `truncated` and `totalLines`, and `FileContentPane.vue:143,148,178-181`
    already renders three distinct notes from them. Re-encoding
    `unsupported: 'binary'`, `unsupported: 'too-large'` and the truncation case as
    symbol-side variants puts two sources of truth for one question on one
    response — and risk 4 names the union collapsing as the most likely way this
    goes quietly wrong. You cannot collapse states you never split. Shrink the wire
    union to three variants: `{status:'ok', symbols}`,
    `{status:'unsupported', reason:'language'}` (plus `'no-script-block'` from item
    28), and `{status:'unavailable', reason:'deadline'|'error'}`. Keep all six UI
    strings — the popover derives the other three from the flags it already holds.

31. **Degrading the staged side unconditionally throws away the commit-review
    case.** §10.1.2 says a staged-vs-HEAD diff degrades to hunk-only
    unconditionally because symbol lines are worktree lines. Right for the general
    case, wrong for the common one. The Changes view keys diffs by side —
    `workingDiffKey` returns `s:path` or `u:path`
    (`packages/web/src/stores/repo.ts:168-170`) — and a file with both staged and
    unstaged changes appears as two entries. When a file has ONLY a staged entry,
    index and worktree content are identical and worktree symbol lines map exactly.
    That is the state a user is in every time they `git add` and review before
    committing, which is this app's primary workflow. Degrade the staged side only
    when the same path also has an unstaged entry (`files.has('u:' + path)`) — one
    map lookup the store already builds (`repo.ts:886`). Compare-base and history
    stay unconditionally hunk-only; those really are foreign coordinate spaces. One
    test per branch.

32. **The `/version` capability probe is on the wrong route and would advertise
    the wrong thing.** §10.1.2 adds `symbols: { languages: string[] }` to
    `GET /version` "so the UI can hide a dead key rather than offer one". Two
    problems, both verified. The natural source is the static
    `EXTENSION_TO_GRAMMAR` map, which is true of the code and not of the install —
    so if a `.wasm` is missing from the tarball (B5 is exactly how that happens),
    `/version` still advertises TypeScript and every request comes back
    `unavailable`. And `/version` is the one route that reaches the public
    internet: `packages/daemon/src/routes/version.ts:13` awaits
    `deps.version.state()`, which fetches `registry.npmjs.org` with a 5 s timeout
    on a cold cache (`packages/daemon/src/version.ts:38-44`), and the web store
    polls it hourly, best-effort and silent. Put the list on `GET /health`
    (`packages/daemon/src/routes/health.ts:7-11` — local, instant, already
    capability-shaped) and derive it from grammars whose file is present and whose
    checksum matches, resolved once at daemon start, the way `resolveWebRoot`
    (`packages/daemon/src/index.ts:228-233`) proves the web assets exist before
    claiming the capability. Or cut the field: the per-file
    `unsupported: 'language'` string is already required and is a better answer
    than a silently dead key.

33. **A new `core/src/symbols/` directory is invisible to every existing
    dependency-cruiser rule, and the claimed backstop does not exist.** Core's
    config enumerates directories by name — `^src/git/`, `^src/utils/`,
    `^src/services/`, `^src/types/`, `^src/view/`, `^src/managers/`
    (`packages/core/.dependency-cruiser.cjs`, rules at :6, :13, :20, :27, :36,
    :44, :60). `^src/symbols/` matches none of them, in either position. The
    consequence that matters: `view-no-node-runtime` (:52-58) forbids `view/` from
    runtime-importing `^src/(git|utils)/` and nothing else, so `core/view/*` is
    free to runtime-import `symbols/extract.ts` and pull `web-tree-sitter` and
    `node:fs` into the web bundle — which that rule's own comment says is exactly
    what it exists to catch. Separately, §10.1.2 says "the root workspace config
    catches the cross-package case". It does not: the root config contains exactly
    one rule, `no-circular` (`.dependency-cruiser.cjs:20-27`), and cannot express a
    forbidden import; and `deps:workspace` (`package.json:27`) deliberately does
    not scan `packages/web/src`, as the root config's own header states at :13-16.
    So the web-side ban has no backstop and must be correct in
    `packages/web/.dependency-cruiser.cjs` on the first try — where its existing
    `no-core-managers` comment (:18-29) records that dep-cruiser cannot resolve
    core's exports-map subpaths, so the ban lands on the raw specifier. **Fix, in
    the same commit that creates the directory:** extend `view-no-node-runtime`'s
    `to` to `^src/(git|utils|symbols)/`; add `symbols-pure-no-extract` (the pure
    modules may not reach `extract.ts`) and `symbols-no-managers`; extend
    `view-no-git-libs` to ban `web-tree-sitter`; and put the web/cli bans in their
    own package configs as raw-specifier regexes. Then add a test that a
    deliberately-added import actually trips `bun run lint` — a rule that matches
    nothing passes vacuously, which is the failure mode `no-in-process-git`'s
    comment already warns about.

34. **Symlink containment silently moves from the daemon's guards into an
    untested git internal.** Every other content route enforces containment twice,
    lexically then by realpath, and `packages/daemon/src/routes/explorer.ts:8-15`
    states the invariant outright: the daemon never serves host files through a
    repo symlink. Grep skips both guards by construction — no client path, and the
    result paths come from git. Containment therefore rests entirely on git
    refusing to read non-regular files. Verified that it holds on 2.55.0: a symlink
    to a file outside the root and a symlink to a directory outside the root both
    returned zero matches, tracked (mode 120000) and untracked alike. So this is
    not a hole today. It is the daemon's strongest invariant resting on an upstream
    detail nobody has written down, in the one route that opted out of the guards,
    and §10.2's test list has no symlink case. Add both fixtures and write the
    reason in `grep.ts`'s header.

35. **Bare `F` cannot be a toggle.** §9's table promises it, and the CLI parity
    argument rests on the word. `Ctrl/⌘+P` can close the finder because it sits
    above the `isEditable` guard
    (`packages/web/src/composables/useGlobalKeys.ts:96-110`), so it fires while the
    input has focus. A bare letter cannot go there. Placed anywhere legal it is
    below `isEditable` at `:121` — so it never fires while the search input is
    focused, and `SearchOverlay` is modelled on `FinderOverlay`, which autofocuses
    — and, with the other bare keys, below `if (ui.activeOverlay !== null) return`
    at `:129`, which returns first. Either way bare `F` can only open. Change the
    table entry to "open repo text search" and say that Escape (`:112-118`) and
    Ctrl/⌘+Shift+F are the two ways to close it. The same caveat applies to bare
    `o` once the popover's filter input has focus.

36. **The golden hunk-key stability test that risk 6 relies on does not exist.**
    Risk 6 commits to checking the funcname text change from `core.attributesFile`
    "against the golden test, not assumed". `grep -rln "golden" packages/` returns
    nothing. The nearest coverage is
    `packages/web/src/utils/diffRows.test.ts:268` (`describe('content-stable
    keys')`), which builds a model twice from the same hand-written `@@` fixtures
    and asserts the keys match (`:294-296`). It has no pinned key strings and no
    real git output, so a change in what git writes after `@@ ... @@` is invisible
    to it by construction. Either write the test slice A claims to be protected by
    — generate a diff from a real fixture repo with and without the bundled
    attributes file and assert the resulting hunk keys explicitly — or state the
    truth: the funcname change re-keys hunks for the affected languages, nothing in
    CI detects it, and the observable effect is one lost scroll position after
    upgrade. For accuracy: per-hunk edit timestamps are safe, because
    `hashHunkBody` deliberately excludes the `@@` header
    (`packages/core/src/git/hunkTimes.ts:7-12`), and URL anchors are safe because
    `at` carries the section key, not a hunk key.

37. **Risk 7 defers a fix that is one key on the exact line slice A already
    edits.** Slice A opens `createGit` (`packages/core/src/git/gitClient.ts:37-39`)
    to add `config: ['core.attributesFile=…']`. simple-git exposes
    `timeout: { block: ms }` as a sibling key on the same options object
    (`simple-git@3.36.0/dist/src/lib/types/index.d.ts:84-102`, with
    `config: string[]` at `:126-128`). Deferring means touching this line twice and
    leaving every non-grep git call able to wedge a request indefinitely in the
    meantime — the hazard grep is being hand-hardened against. Add
    `timeout: { block: 10000 }` in the same commit. The one genuinely load-bearing
    precondition for slice A is already satisfied: `allowUnsafeConfigPaths: true`
    is set at `gitClient.ts:28`, without which simple-git would reject a
    `core.attributesFile` path outright.

#### Judgement calls — argued, not defects

These are reasoned recommendations. Nothing in the code contradicts the design as
written; the design is invited to disagree, in writing.

38. **The packaging cost is stated in the unit that flatters it.** §10.1.1's only
    ratio is "a 2.4x tarball", the smallest one available: wasm compresses ~10:1
    while the existing tarball is already minified JS at ~3:1. `npm pack
    --dry-run` on the daemon today reports 197.6 kB packed / **587.7 kB unpacked**
    (so §10.1.1's own "671,611 B unpacked" is stale too). The grammars are roughly
    2.5-2.7 MB on disk from the doc's own raw figures. The honest statement is
    ~0.59 MB to ~3.2 MB installed, a 5.4x. Still defensible, but the per-language
    unpacked spread — ~1.4 MB for TypeScript against ~0.4 MB for Java — is a 3.5x
    the compressed numbers (134 KB vs 50 KB) understate, and that is the unit the
    next language's decision is made in. Quote both.

39. **The JavaScript grammar is probably redundant.** The launch set ships four
    grammars, one of them `javascript`. tree-sitter's TypeScript grammar is derived
    from the JavaScript one and is a superset short of JSX and Flow — and TSX is
    already dropped from the launch set, so JSX-in-`.js` is out of scope anyway. In
    this repo the whole `.js`/`.cjs`/`.mjs` corpus is 12 files, all config
    (`eslint.config.js`, `.dependency-cruiser.cjs`, `eslint.metrics.js`), and zero
    `.jsx`. Mapping those extensions to the typescript grammar costs one line in
    `EXTENSION_TO_GRAMMAR` and reuses `typescript.scm`; shipping a separate grammar
    costs 48,211 B gzipped, a second checksum entry, a second ABI startup test, a
    second golden fixture set, and half of slice F. Not verified: whether every
    construct in the 788 `.js` files across the author's other repos parses cleanly
    under the TS grammar. Measure that before deciding, not after.

40. **`GREP_MIN_QUERY = 3` mostly removes value.** Its stated purpose — a
    one-character query scanning the tree on every keystroke — is already bounded
    by the debounce, kill-on-supersede, `-m 20`, the 500-result cap, the byte cap
    and the timeout. What it costs is frequent in this codebase's own idiom: `id`,
    `db`, `fn`, `ok`, `=>`, `@@` are all rejected with a 400. Three characters is a
    limit sized for a hosted multi-tenant search box, applied to a unix socket
    serving one person. Set it to 2, or let the empty query be the only rejection.

41. **The 500-result cap truncates in path order, which is the least useful 500.**
    `git grep` emits in index order, so a common term returns everything under
    `.github/`, `docs/` and `packages/cli/` and never reaches `packages/web/` —
    the package actively worked in. The copy "showing the first 500 of more" is
    honest about the count and silent about the ordering, which is the part that
    decides usefulness, and §7 correctly rejected path-narrowing DSL modifiers so
    the user has no lever. Two near-free fixes: say the order in the copy, and run
    the returned file list through the existing `createFinderIndex`
    (`packages/core/src/view/finderModel.ts:45`) as a client-side path narrow
    inside the overlay. No new endpoint, no new cap. Do not add server-side
    pathspec filtering.

42. **The semaphore citation argues against the design's own choice.** §10.2 says
    the grep gate reuses `createBlobSemaphore` "same reasoning as the blob gate
    (`server.ts:199`)". That comment says the opposite: one gate exists *because*
    two routing tables share one machine's process budget. A separate grep gate is
    a second budget — 4 concurrent `cat-file` children plus 2 concurrent
    `git grep` children, and grep is far heavier. The choice is probably still
    right (blocking image loads behind a tree-wide grep would be worse), but it is
    a new decision, not the existing one reused. Say so in one sentence, and
    construct it as `createBlobSemaphore(GREP_CONCURRENCY, GREP_QUEUE_LIMIT)` at
    the same place `blobGate` is built, passed into `registerSearchRoutes` the way
    `blobGate` is passed at `server.ts:222`. Note the counter-argument this review
    also heard and rejected: that the gate guards an unreachable state, because a
    debounced single-flight overlay cannot fill 18 slots. That is true of the web
    UI and false of every non-browser client, and item 25 shows the daemon's real
    exposure is worse than the design assumed, not better. Keep the gate; fix its
    queue depth per item 17.

#### The designers' original risks, kept

All fourteen survive review. Items 1 to 14 are the design's own; the numbering is
unchanged so earlier references still resolve. Items 2, 3, 4, 6, 7, 10 and 13 are
amended above and the amendments are load-bearing.

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
   enforced. **Amended by item 38: quote the unpacked number too, and B5 may
   change the packaging model entirely.**
3. **A wrong symbol label is the failure that discredits the feature.** That is
   why an unmappable context (staged-vs-HEAD, compare base, history) degrades to
   hunk-only, why a null enclosing symbol renders blank and never as the nearest
   guess, and why a scanned symbol and git's `@@` text never share a column.
   **Amended by item 31 (staged-only is mappable) and by B3, which is a mechanism
   for producing wrong labels that this risk did not anticipate.**
4. **The status union collapsing.** Six states, six strings. This is the most
   likely way the feature becomes quietly wrong, and it will happen through an
   innocent-looking simplification in a Vue template, not through a design change.
   Test each string. **Amended by items 29 and 30: two of the six collapses are
   already in the design, not waiting to be introduced.**
5. **`workingDiffs` is cold until Changes has been activated once**
   (`stores/repo.ts:687,1038`, risk 5). Unchanged and still true. The outline is
   built from the `/file` read specifically so this cannot bite; anything that
   later moves it to `workingDiffs` reintroduces a silent zero-result bug.
6. **Hunk identity** (risk 3). `hunkKeyFor` hashes the `@@` context
   (`web/src/utils/diffRows.ts:224`). Nothing in this plan touches
   `parseHunkHeader`, and nothing should. The attributesFile graft in slice A
   changes the funcname **text** git produces for some languages, which does not
   touch `hunkKeyFor`'s inputs on any diff already rendered — but it does mean
   hunk keys computed before and after the upgrade differ for those languages.
   That is a one-time reload. **Amended by item 36: the golden test this risk
   points at does not exist. Write it or state the consequence plainly.**
7. **The unbounded git client is still unbounded.** `gitClient.ts:38` gained no
   timeout and no `maxBuffer` in this plan; grep simply does not use it. Every
   other caller still does. **Amended by item 37: this is one key on the line
   slice A already edits. Stop deferring it.**
8. **The `POST`-not-`GET` decision is load-bearing and non-obvious.** A future
   refactor "correcting" a read to a GET reopens the CSRF-exempt timing oracle in
   §7. The reason belongs in the route's module header, and a test should assert
   the method. **Amended by item 22: half of the stated reason is false today.
   Make it true before writing it down.**
9. **Non-UTF-8 output.** Handled by decoding lossily and re-finding offsets in the
   decoded string, but the hazard is permanent: any future code that reads grep
   output as a string before splitting reintroduces it. **See B2 and item 24 —
   both the split order and the re-find have defects today.**
10. **The deadline is a real state, not a theoretical one.** A minified bundle or
    a high-entropy blob that slips past the NUL scan will hit it. It must render
    as "outline unavailable", never as an empty list. **Amended by B3 and B4: the
    deadline firing is not merely a visible state, it is currently a
    corruption.**
11. **Lint budget** (risk 6). 0 errors, 20 warnings. A search overlay with six
    empty states and a popover with six status strings are exactly the shape that
    trips sonarjs cognitive-complexity. Keep the decisions in small pure functions
    in `core/symbols/mapping.ts` and `core/view/`, which is also what makes their
    caps testable without mounting anything.
12. **Grammar ABI drift.** A `web-tree-sitter` bump can stop loading a vendored
    grammar. The pin is exact and a startup test loads every shipped grammar, so
    this fails in CI. Without that test it fails in a user's terminal.
13. **The Vue `includedRanges` scanner is ours and has no upstream.** It degrades
    to "no symbols" rather than to wrong symbols, which is the right direction to
    fail, and it needs fixtures. **Amended by item 28: it is specified as
    singular and three files in this repo already have two script blocks. And
    "degrades to no symbols" is only safe once the empty-`ok` collapse in item 30
    is fixed — until then "no script block found" and "this file has no symbols"
    render the same string.**
14. **Follow mode taking the viewport** while the search overlay or the outline
    popover is open (risk 4). Decided in both places above — close, do not fight
    the view switch — and it needs the `useFollowMode.test.ts` cases to actually
    be written.

#### What was checked in code, and what was not

Checked by reading the real source or by reproducing against real tooling: B1,
B2, B3, B4, B5 and items 15 to 37. Every file:line reference above was opened.
The git behaviours (`grep.column`, raw newlines in `-z` paths, the 8000-byte
binary sniff, `.gitattributes -text diff` defeating `-I`, `--untracked` honouring
`.gitignore`, symlink non-traversal, ASCII-only `-i` folding under `LC_ALL=C`)
were reproduced on git 2.55.0 in throwaway repos. The tree-sitter behaviours
(parser poisoning after a cancelled parse, `reset()` failing to recover, unbounded
query execution, `matchLimit` and a query `progressCallback` failing to bound it,
zero `FinalizationRegistry` in the shipped bundle) were reproduced against
web-tree-sitter 0.26.11 and tree-sitter-typescript 0.23.2 — the exact versions
§10.1 names.

Reasoned judgement, not verified: items 38 to 42. Item 39 in particular rests on
an unmeasured claim (that the TypeScript grammar parses the author's whole `.js`
corpus cleanly); measure it before dropping the grammar.

**One claim was dropped as unreproduced.** A lens reported that passing the
TypeScript grammar a wrong `includedRange` returns `(program)` with
`hasError=false` and zero captures — a confident, error-free, empty parse
indistinguishable from an honestly empty file. It did not reproduce: a
deliberately wrong range returned `hasError=true` with a non-empty tree. The
underlying concern is still real and is recorded as item 28, but on the verified
ground (two script blocks, and an empty `ok` with no distinct outcome) rather than
on that mechanism.
