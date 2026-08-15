# Repo picker redesign

One decision document for the web UI's repo switcher. Written 2026-08-15.
Target: `packages/web` only. The CLI keeps its own repo picker and is not
touched.

This is a spec, not a menu. Where two readings were possible, the choice is
made here and the reason is on the same line.

---

## 1. What is wrong today

The panel is three lists stacked on top of each other — "Open on daemon",
"Discovered", "Recent" — each with its own heading, competing for the same
eye. On a real machine "Discovered" alone is 63 rows, so the panel is taller
than the viewport and the thing the user actually wants (the four repos they
worked on this week) is pushed around by folders they have not opened in a
year. The one filter that exists is buried in the middle of the panel,
appears only past 8 discovered rows, and narrows *only* the discovered list —
it cannot find a recent repo. Above all of that sits a separate path field
with its own Open button, prefilled with the active repo's path, which is a
fourth control doing a job the filter could do. The result is four ways in
and no obvious one.

---

## 2. The four requirements as design rules

The user asked for four things. They become four rules.

1. **One input, at the top, that both filters and opens.** The separate path
   form is deleted. The single input narrows the list as you type. When what
   you typed *precisely* names a directory that diffstalkerd can open — bare
   layouts included — an **Open button** appears beside it. It appears for
   nothing else.
2. **One list. Open repos are part of it, at the top, labelled.** "Open on
   daemon" and "Recent" merge into one list, open first under an `OPEN`
   eyebrow. Nothing is duplicated between them.
3. **Filtering searches everything and shows a list.** A non-empty query
   searches open, recent *and* discovered repos, in one list, without any
   extra gesture.
4. **Discovered is behind one control, hidden by default.** With an empty
   query the panel shows only repos the user has deliberately touched, plus
   one row that says how many discovered repos exist and reveals them.

---

## 3. Panel anatomy

The panel is 24rem wide (unchanged, and inside `.popover-panel`'s 80vw phone
cap). New: **`RepoPicker`'s own list region** carries `max-height: 60vh;
overflow-y: auto`, with the input pinned above it. The cap belongs to the
picker, not to the switcher's panel, so both mount sites get it — the empty
state's card sits in a `height: 100%` centred flex container, where a card
taller than its container pushes its own heading and input above the scroll
origin, out of reach. 60vh matches `WorktreeSwitcher`, the sibling popover.
This overturns the "RepoSwitcher's panel has no max-height on purpose" note
in `style.css`, which gets rewritten in the same commit: a merged list with a
reveal control cannot be allowed to push the input off screen.

Notation in the wireframes below: `▌` marks the keyboard-selected row (rail +
`--row-selected-bg`); a name in `«accent»` is the active repo.

### Closed trigger

Unchanged.

```
[ diffstalker ▾ ]
```

### Open, empty query

The default. Open projects first, then recents, then the reveal control.

```
+----------------------------------------------+
| [ filter repos or type a path             ]  |
|                                              |
| OPEN                                         |
|▌«diffstalker»                   4 worktrees  |
|▌/home/jorn/gitRepos/diffstalker              |
| calculator                      3 worktrees  |
| /home/jorn/aerius/calculator                 |
| RECENT                                       |
| grip                            2 worktrees  |
| /home/jorn/aerius/grip                       |
| schaduwstats                                 |
| /home/jorn/gitRepos/schaduwstats             |
|                                              |
| Show 54 discovered repos                     |
|----------------------------------------------|
| up/down move  enter open  esc close          |
+----------------------------------------------+
```

### Typing a name

The query searches every source. Discovered rows join the list with their
branch and age. The reveal control is gone — the query already reaches them.

```
+----------------------------------------------+
| [ arch                                    ]  |
|                                              |
| RECENT                                       |
|▌archive-service                 3 worktrees  |
|▌/home/jorn/aerius/archive-service            |
| DISCOVERED                                   |
| archetype                              main  |
| /home/jorn/gitRepos/archetype       8mo ago  |
| march-madness                          main  |
| /home/jorn/play/march-madness        2y ago  |
|----------------------------------------------|
| up/down move  enter open  esc clear          |
+----------------------------------------------+
```

Matched characters in the path line are highlighted (`.hit`, `--warn`).

### Typed path that is a repo

The probe answered `openable` for exactly this string. The Open button
appears beside the input; its `title` is the root the daemon will actually
open (which differs from the typed path for a bare container). No extra row
is invented for it.

```
+----------------------------------------------+
| [ /home/jorn/gitRepos/hetverl ]  [ Open ]    |
|                                              |
| DISCOVERED                                   |
| hetverledenvan                         main  |
| /home/jorn/gitRepos/hetverledenvan   3d ago  |
|----------------------------------------------|
| up/down move  enter open  esc clear          |
+----------------------------------------------+
```

### Probing

While the probe is in flight, a dim note under the input. No button, so
Enter has nothing to do (see section 7).

```
+----------------------------------------------+
| [ /home/jorn/gitRepos/hetverl             ]  |
| checking path...                             |
|                                              |
| (matches, if any)                            |
+----------------------------------------------+
```

### Typed path that is not a repo

```
+----------------------------------------------+
| [ /home/jorn/Downloads                    ]  |
| not a git repository                         |
|                                              |
| no repo matches "/home/jorn/Downloads"       |
+----------------------------------------------+
```

### Discovered expanded

The reveal control was activated with an empty query. Discovered rows append
under their own eyebrow; the whole list scrolls inside the 60vh cap. The
control re-labels to `Hide discovered repos`.

```
+----------------------------------------------+
| [ filter repos or type a path             ]  |
|                                              |
| OPEN                                         |
| ... (as default) ...                         |
| RECENT                                       |
| ... (as default) ...                         |
| DISCOVERED                                   |
|▌yogh-site                              main  |  ]
|▌/home/jorn/gitRepos/yogh-site        1w ago  |  ]
| aoc-2025                               main  |  ] scrolls
| /home/jorn/play/aoc-2025            8mo ago  |  ]
| ...                                          |  ]
|                                              |
| Hide discovered repos                        |
+----------------------------------------------+
```

### No matches

```
+----------------------------------------------+
| [ zzzz                                    ]  |
|                                              |
| no repo matches "zzzz"                       |
+----------------------------------------------+
```

### Daemon down, or the probe could not be reached

Recents live in localStorage and open repos live in the Pinia store, so the
list still renders. The connection line comes from `daemon.connection`, not
from `repo.shared.error` — with nothing open there is no repo stream to have
dropped. The reveal control hides in its collapsed state, because discovery
is stale and cannot be refreshed; if it was already expanded it stays
expanded and keeps its `Hide` control, so the user is never stuck expanded
with no way back. Picking a row still tries; the refusal lands in the note
slot (section 5).

This frame has no repos open on the daemon, so there is no `OPEN` section.

```
+----------------------------------------------+
| [ filter repos or type a path             ]  |
| daemon connection lost - reconnecting...     |
|                                              |
| RECENT                                       |
| grip                            2 worktrees  |
| /home/jorn/aerius/grip                       |
| schaduwstats                                 |
| /home/jorn/gitRepos/schaduwstats             |
+----------------------------------------------+
```

### Empty state page

`RepoEmptyState` embeds the **same** `RepoPicker`, inline, with no popover
and no dismiss behaviour. Its own flat recents list is deleted, so the empty
state and the header panel cannot drift apart.

```
+------------------------------------------------------+
|                    [add][del][ctx]                   |
|                 Open a repository                    |
|  diffstalker follows a repository on the daemon's    |
|  machine. Type a name to pick one, or an absolute    |
|  path to open a new one.                             |
|                                                      |
|  [ filter repos or type a path              ]        |
|  RECENT                                              |
|  grip                                                |
|  /home/jorn/aerius/grip                              |
|  ...                                                 |
|  Show 54 discovered repos                            |
+------------------------------------------------------+
```

**One behaviour is knowingly given up here.** Today the empty state paints
`ui.recentRepos` straight from localStorage with no daemon involved. The
picker holds unresolved recents back (section 4), so on a cold start they
appear one worktree round-trip later. That beat is the price of the stray-row
fix, and both mount sites pay it: an empty-state-only exception would be the
kind of divergence the house rules forbid. It goes in the changelog beside
the prefill loss.

---

## 4. The list model

### Sources to rows

| Section eyebrow | Source | Row kind | Row shows | Activating it |
| --- | --- | --- | --- | --- |
| `OPEN` | `daemon.repos`, folded per project root via the worktree store | `open` | name (accent when this project holds the active repo), `N worktrees` when the family has more than one, project root path | `activate()` on the active repo of the project if it is in this family, else its first open repo |
| `RECENT` | `ui.recentRepos` minus paths open on the daemon, folded per project | `recent` | name, `N worktrees` when the family has more than one, project root path | `openByPath(bestWorktreePath)` — the freshest worktree of the family, or the root when nothing resolved |
| `DISCOVERED` | `settings.discoveredRepos` | `discovered` | name (dimmed when stale), branch, path, relative age | `openByPath(repo.path)` |
| (none) | the reveal control | `more` | `Show N discovered repos` / `Hide discovered repos` | toggles the expanded flag |

**Every section with rows gets its eyebrow, always** — including a lone one.
The `OPEN` label is requirement 2's "special label", and a single section is
exactly when a reader most needs to be told which one it is. (This departs
from `WorktreeSwitcher`'s two-or-more rule on purpose: that list has one
source, this one has three.) Per-row source badges were considered and
rejected: over 60 rows they are per-row noise, and tier order plus one
eyebrow already says it.

### Ordering

Sections in the fixed order above. Within a section, the source's own order,
never re-ranked:

- open: `daemon.repos` order;
- recent: `ui.recentRepos` order, most recent first;
- discovered: the settings store's order — `lastActivity` descending, nulls
  last, ties by name.

Filtering **preserves** these orders. It filters each source list against the
set of paths fzf matched; it never takes fzf's ranking. This is the
`useTextFilter` rule, and it holds here for the same reason: these lists are
ordered for a reason (recency, activity), and a fuzzy score would scramble
that.

### Dedup

- **Open beats recent**, by project root. A recent whose project root is
  already an open row is dropped.
- **Open and recent beat discovered**, by path. The excluded path set is:
  every open repo's path, **every open project's root and every worktree path
  of its resolved family**, plus every recent project's root and every
  worktree path of its family.
- Within recent, one row per project root; the first path that resolves to a
  root wins.

The open-family part of that set is new, and it is what lets a merged list
claim uniqueness at all. Discovery finds any directory holding a `.git` entry
and a linked worktree's `.git` is a file, so in a bare layout
(`~/w/calculator/.bare` with `main` open) every sibling worktree is its own
discovered repo — rendering as `calculator — 3 worktrees` under OPEN *and*
`~/w/calculator/feat-x` under DISCOVERED. Three separate lists just about got
away with that; one list cannot. The worktree store already holds the family
(`worktreeStore.projectFor(path)`, ensured for open paths anyway).

Recent rows are held back or dropped by worktree-store status, unchanged:

- `undefined` / `pending`: **held back**. Several worktrees of one project
  resolve to the same row, so drawing them early shows a stray row per
  worktree that then vanishes.
- `absent`: **dropped**. The daemon looked and the path is not a worktree.
- `failed`: **rendered by its own path**. We could not ask, so this is not
  evidence the path is bad.
- `ready`: folded to its project.

**The invariant, at the strength it is delivered:** no path and no project
family renders in more than one row, *once its worktree lookups have
answered*. Resolutions land per path and independently, so a project can sit
in both OPEN and RECENT for the beat between its two lookups. That window is
a frame or two and self-heals; a barrier against it would delay the whole
list on the slowest lookup.

When a typed path resolves to a repo that is already a row, the Open button
and that row coexist — the button is a control, not a row, so there is no
duplicate row to suppress.

### The single builder

```
packages/web/src/components/repoPickerRows.ts
  buildRepoRows(input): PickerRow[]
```

Pure, no store access, no Vue. Input: the open projects, the recent projects,
the discovered repos, the **trimmed query**, and the `expanded` flag. The
matching happens *inside* — `createFinderIndex` from
`@diffstalker/core/view/finderModel` is pure and browser-safe — so the
path-to-haystack mapping exists in exactly one place and each row can carry
its match `positions` for the `.hit` rendering. (An empty query needs no
special case: with `limit` set to the haystack count, `find('')` returns
every item with empty positions.)

Output: one flat `PickerRow[]` carrying section boundaries, so that **render,
the keyboard index, and every count read the same array**. Nothing counts
rows a second time anywhere.

`PickerRow` is a discriminated union on `kind`: `'section'` (an eyebrow, not
selectable), `'open'`, `'recent'`, `'discovered'`, `'more'`. Only the last
four are in the keyboard index. Every selectable row carries a stable
`key`: `open:<root>`, `recent:<root>`, `discovered:<path>`, `more`.

---

## 5. The Open affordance

### The rule

The Open button is rendered when, and only when, the trimmed input starts
with `/` or `~` **and** the probe state is `openable` **and** the string the
probe answered for is character-for-character the current trimmed input.
Anything else is filter-only and never touches the network.

### One resolver, called twice

New in `packages/core/src/git/worktree.ts`:

```
resolveRepoRoot(inputPath, { mustExist }): Promise<
  { ok: true; root: string } | { ok: false; reason: 'not-absolute' | 'not-a-repo' }
>

expandPath(input)                     ~ expanded at the daemon's trust boundary
  not absolute?                    -> not-absolute
  mustExist && not an existing dir -> not-a-repo          <-- the stat, see below
  resolveWorktreeRoot()            -> root                2 git rev-parse calls
  still null?                      -> pickDefaultWorktree(listWorktreesRaw(path))
  nothing?                         -> not-a-repo
```

`RepoRegistry.openRepo` calls it with `mustExist: false` and maps the two
refusals onto the errors it already throws; its inline copy of the chain is
**deleted in the same step**. `GET /resolve` calls it with `mustExist: true`
and maps `not-absolute` to 400, `not-a-repo` to `{ openable: false, root:
null }`. One resolver, not two plus a drift test: a probe that answers
`openable` for something `POST /repos` then refuses is a lie told at the
moment of highest trust, and a drift test only polices the cases someone
thought to enumerate.

**Why `mustExist` only on the probe.** `toDirectory` falls back to the
*parent* directory when a path does not exist, so without the stat
`/home/jorn/gitRepos/diffstalker/nope` resolves to the repo above it and the
Open button lights up for a typo. The requirement says the button appears
when the input *precisely matches* a directory, so the probe is deliberately
**stricter** than `POST /repos`, never looser. That asymmetry is the flag's
only job, and the function carries the reason as a comment.

**Cost.** The fallback uses a new `listWorktreesRaw()` — `toDirectory` +
`git worktree list --porcelain` + `parseWorktreePorcelain`, no enrichment.
`pickDefaultWorktree` widens to `RawWorktreeInfo[]`: it only reads `isBare`
and re-derives activity itself, and `WorktreeInfo extends RawWorktreeInfo`,
so every caller still compiles. `openRepo` moving onto the raw list drops a
base-branch scan (`git log --all` plus a `rev-list` per worktree) it never
read — a saving, not a compromise made for the probe.

### The endpoint

New: `GET /resolve?path=` in `packages/daemon/src/routes/repos.ts`. Top-level
and path-keyed, like the existing `GET /worktrees?path=` — a name under
`/repos/...` would sit next to the `:id` param routes for no gain.
`routes/repos.ts` is registered on both API surfaces, so the browser gets it
for free.

```json
{ "openable": true, "root": "/home/jorn/gitRepos/diffstalker" }
```

`root` is the path `POST /repos` would actually open, or `null`.

**Bare layouts** come out of the shared fallback: a bare container or a
`.bare` directory fails `resolveWorktreeRoot`, `pickDefaultWorktree` picks its
most recently active non-bare worktree, and that path is the `root`. The
button's `title` shows it, so the user sees which worktree Enter will open.

**Why not the existing endpoints.** `GET /worktrees?path=` does not expand
`~`, has the parent fallback above, and on a hit runs base-branch discovery —
far too expensive per keystroke. `GET /browse` describes a directory's
*children* and its `isRepo` is a plain `.git` entry check, which misses bare
layouts. Reimplementing openability in the browser is out: the web UI is a
pure daemon client, and a second opinion would drift from what opening does.

### Client side

- `resolvePath(path)` on `@diffstalker/client`'s `DiffstalkerClient` and on
  the browser client (`packages/web/src/api/client.ts`), with a `RepoResolve`
  wire type in `packages/client/src/wire.ts`.
- **Debounce 250 ms** after the last keystroke. Precedent: discovery's 300 ms
  watcher debounce. The finder's 15 ms is for in-memory work and is the wrong
  scale for spawning git processes.
- **Race handling:** a monotonically increasing token per request; an answer
  whose token is not the latest is dropped. Same stale-guard shape as
  `RepoSession`'s diff pull.
- The probe state is `{ state, answeredFor }`: `idle` (input not path-like),
  `checking`, `openable`, `not-a-repo`, plus the string the answer was for.
  The button and the Enter shortcut both require `state === 'openable' &&
  answeredFor === trimmedInput`, so a single extra keystroke disarms them in
  the same tick — the token guard only orders answers, it cannot express
  "this answer is about a string you have since edited".
- **Any non-2xx answer is `not-a-repo`** (the note may carry the daemon's
  reason). Only a transport failure is `could not reach daemon`. This matters
  more than it looks: `expandPath` expands only `~/` and bare `~`, so `~jorn/x`
  and every keystroke of `~g...` reach the daemon still relative and come back
  400. Calling that a transport failure would claim the daemon is unreachable
  while it is answering.
- The probe logic lives **inside `RepoPicker.vue`** (about twenty lines: a
  timer, a token, a ref). A composable for it would be surface without reuse.

### The note slot

One slot under the input, first match wins:

1. `daemon.connection === 'disconnected'` → `daemon connection lost -
   reconnecting...` (dim). Derived from the daemon store, because with no
   repo open `repo.shared.error` carries nothing.
2. `openError` — a **picker-local** ref, set from `repo.shared.error` the
   moment `openByPath()` returns false, rendered in `var(--del)`, cleared on
   the next input edit or attempt. Local because neither half of the old
   form's binding works here: its gate (`repo.isRepo ? null :
   repo.shared.error`) shows nothing for the panel's commonest failure, since
   a refusal while another repo is active leaves `isRepo` true; and dropping
   the gate would put any live git error from the active repo's SSE stream
   under the input, as if the typed path were at fault.
3. The probe: `checking path...` / `not a git repository` / `could not reach
   daemon` (dim).

Notes never enter the keyboard index. The list only ever contains rows you
can act on.

---

## 6. The discovered disclosure

- **Label:** `Show 54 discovered repos`, where the count is
  `discoveredRepos.length` **after** dedup — the number of rows revealing
  will actually add. When any watch root reports `capped`, the label reads
  `Show 500+ discovered repos (list incomplete)`; the cap is surfaced in the
  control itself rather than as a separate note row, so a truncated list is
  never presented as complete.
- **Placement:** the last row of the list, below a hairline, styled like
  `WorktreeSwitcher`'s `.more-row` — small, dim, hover raises. It must not
  look like a repo row. It is rendered **outside** the `role="listbox"`
  element (see section 7).
- **Default:** collapsed. That is the requirement.
- **Collapsed and visible when:** the query is empty *and* at least one
  discovered repo survives dedup *and* the daemon is reachable.
- **Expanded:** the control stays rendered whatever the connection does. A
  disconnect that hid it would leave the user expanded with no way to
  collapse.
- **With an active filter:** hidden. Typing already searches discovered, so
  the control would be a second way to do what just happened.
- **When expanded:** discovered rows append under the `DISCOVERED` eyebrow
  and join the keyboard index; the control re-labels to `Hide discovered
  repos` and stays at the bottom.
- **Persistence:** none. The picker is mounted with `v-if` when the panel
  opens, so query, selection and the expanded flag reset structurally when it
  closes.

### Data fetching on mount, and after

`settings.rescan()` fires **on mount**: branch labels only refresh on a scan,
and a scan is filesystem-only.

`worktreeStore.ensure()` fires from a **watcher inside the picker**:

```ts
watch(neededPaths, (paths) => void worktreeStore.ensure(paths), { immediate: true });
```

Mount-only would be wrong, and worst where it matters most. The empty-state
instance mounts once and stays mounted, and the daemon's snapshot lands
*after* that mount: a project with two worktrees open would render as two
unfolded rows forever, `failed` lookups would never be retried (contract 4
has no "next open" there), and a repo opened in another tab over SSE would
never resolve. `ensure` skips what it knows and dedups in flight, so the
watcher costs one request per unknown path however often it fires. It
replaces today's `watch([open, neededPaths])` in `RepoSwitcher.vue`, whose
open/closed half the picker's own mount lifecycle now covers.

---

## 7. Keyboard, focus and accessibility

The finder combobox idiom from `FinderOverlay`, reused as-is. Focus never
leaves the input.

- Input: `role="combobox"`, `:aria-expanded`, `aria-controls` pointing at the
  list, `aria-activedescendant="repo-option-{index}"`. The list is
  `role="listbox"` with `role="option"` rows carrying `:aria-selected`.
- Movement: `ArrowDown` / `Ctrl+j` and `ArrowUp` / `Ctrl+k` through
  `clampMove` — bounded, **no wrap**. This list has a meaningful top (the
  active repo); wrapping past it is disorienting.
- `Enter` activates the selected row. The probed-root shortcut — Enter opens
  the probe's `root` instead — applies **only while the selection is
  untouched**: one `selectionMoved` boolean, set by any arrow/Ctrl-j/k or
  hover, reset on every input edit. Without it, typing an openable path that
  the fuzzy filter also matches elsewhere (`/home/jorn/gitRepos/diffstalker`
  matches `diffstalker-git` as a subsequence) lets the user arrow onto that
  row and have Enter open something else. The rail and Enter must never
  disagree.
- `Enter` while the probe is `checking` does nothing. It is tempting to fire
  the raw path and let `POST /repos` decide, but `POST /repos` has the parent
  fallback the probe exists to close, so that path would open the wrong repo
  for a typo. 250 ms is not worth that.
- `Escape` is two-stage: with a non-empty query it clears the query and calls
  `preventDefault()` **and `stopPropagation()`**; with an empty query it does
  nothing and `useDismissable` closes the panel as today. In the empty-state
  instance there is no panel, so Escape only ever clears.
  `stopPropagation` is load-bearing — `preventDefault` alone does not do it.
  `useDismissable`'s handler sits on `document` and closes on any Escape while
  open without checking `defaultPrevented` (only `useGlobalKeys` checks it).
  The input's handler runs in the target phase, so stopping propagation there
  keeps the document listener from ever running, and leaves `useDismissable`
  and its test untouched — which is why it beats adding a guard there.
  `useGlobalKeys` is cut off too; its Escape branch is a no-op without an
  active overlay, so nothing is lost.
- **Tab reaches the Open button only.** Options addressed by
  `aria-activedescendant` must not be tab stops, and a focusable button inside
  the listbox would take real focus off the input, after which the input's
  keydown handler stops seeing arrows and Escape. So the reveal control is
  rendered outside the `role="listbox"` element — it already sits below a
  hairline, outside the scrolling options — while staying a synthetic last
  entry in the keyboard index, reached with ArrowDown and fired with Enter.
- Hover **is** selection: `mousemove` (not `mouseenter`) sets the selected
  index, so there is no separate hover background on option rows, and rows
  subtract `--row-rail` from their left padding so text does not shift when
  selected.
- Scrolling: `scrollIntoView({ block: 'nearest' })` on the selected option.
- **Selection is keyed, not indexed.** The component stores the selected row
  *key*; each rebuild resolves that key to an index, and clamps to the same
  index only when the key is gone. Worktree resolution is asynchronous — a
  recent row folds into a sibling or appears late while the user is arrowing
  — and an index-based selection would land Enter on a different repo than
  the one under the rail. This is the likeliest bug in the whole redesign;
  the keying is not optional.
- **Reset is scoped to the query and the expand toggle.** Only a change of
  applied query text, or activating the reveal control, resets the selection
  to the first selectable row and the scroller to the top. Every other
  rebuild — a worktree resolving late, a discovery scan landing — resolves the
  stored key and leaves the scroller alone. Resetting on every rebuild would
  erase the survival the keying exists for, and would yank the scroller away
  from the control the user just pressed.
- Colour roles stay separate: `--row-selected-bg` + `--row-rail`
  (`--selection`, cyan) mark the keyboard selection; `var(--accent)` on the
  name marks the **active** repo. They are never conflated.
- The input autofocuses when the picker mounts (panel open, and the empty
  state, where it is also correct). Popovers do not use `useFocusTrap` —
  that stays overlay-dialog-only.
- A hints footer closes the panel: `up/down move · enter open · esc
  clear/close`, `<kbd>` chips, `aria-hidden="true"`.
- `useDismissable`'s destructured names `open` and `rootEl` must stay exactly
  as they are — Vue matches `ref="rootEl"` against the setup variable name.
- Matching: fzf smart-case via `createFinderIndex`, over one haystack per row:
  the row's **path** (which contains the name as its basename). One haystack,
  one segment map, built inside `buildRepoRows`. Matched characters are
  highlighted on the path line with `toSegments` → `<span class="hit">`. The
  query is a **picker-local ref** — `useTextFilter` reads `useFilterStore`,
  which is the changes-list filter chip's state and must not be shared.
- `data-testid` on every interactive surface: `repo-picker`, `picker-input`,
  `picker-open-btn`, `picker-note`, `picker-options`, `picker-row`,
  `picker-more`.

---

## 8. Implementation plan

### Added

| File | What |
| --- | --- |
| `packages/web/src/components/RepoPicker.vue` | input, probe, note slot, list, reveal control, keyboard model. Emits `opened`. |
| `packages/web/src/components/repoPickerRows.ts` | `buildRepoRows()` and `PickerRow` — the one row builder, matching included. |
| `packages/web/src/components/repoPickerRows.test.ts` | ordering, dedup layers, recent statuses, eyebrow rule, expanded/filtered composition, match positions. |
| `packages/web/src/components/RepoPicker.test.ts` | the component contracts (below). |

### Changed

| File | What |
| --- | --- |
| `packages/core/src/git/worktree.ts` | add `resolveRepoRoot()` and `listWorktreesRaw()`; widen `pickDefaultWorktree` to `RawWorktreeInfo[]`. |
| `packages/daemon/src/repoRegistry.ts` | `openRepo` drops its inline chain and calls `resolveRepoRoot(path, { mustExist: false })`. |
| `packages/daemon/src/routes/repos.ts` | add `GET /resolve?path=`. |
| `packages/daemon/README.md` | endpoint table row. |
| `packages/client/src/client.ts`, `wire.ts` | `resolvePath()`, `RepoResolve`. |
| `packages/web/src/api/client.ts` | `resolvePath()` mirroring it. |
| `packages/web/src/components/RepoSwitcher.vue` | shrinks to trigger + `useDismissable` + popover shell + `<RepoPicker v-if="open" @opened="open = false" />`. No cap of its own — the picker carries it. |
| `packages/web/src/components/RepoEmptyState.vue` | embeds `RepoPicker`; copy updated to mention filtering. |
| `packages/web/src/style.css` | rewrite the "no max-height on purpose" note to record the new cap. |
| `CHANGELOG.md` | the redesign **and** the two dropped behaviours (below). |

### Deleted, in the same step

- `packages/web/src/components/RepoOpenForm.vue`
- `packages/web/src/components/RepoOpenForm.test.ts`
- the prefill-with-active-path behaviour. In a combined filter+open input a
  prefill would immediately narrow the list to the repo you are already in.
  The move it enabled — edit two characters to open a sibling — is a real
  loss and goes in the changelog. If it bites, the fix is a "copy active path
  into the input" affordance later; it is not shipped now, and prefill does
  not come back.
- `DISCOVERED_FILTER_THRESHOLD`, `discoveredFilter`, `showDiscoveredFilter`,
  `filteredDiscovered` and the mid-panel filter input.
- the three-group panel template, its `watch([open, neededPaths])` /
  `watch(open)` blocks, and its `.scrollable` 14rem inner cap.
- `RepoEmptyState`'s flat `empty-recents` list, its `openRecent`, and their
  styles.

### Stores and composables

No store changes. `worktrees`, `ui`, `settings`, `repo`, `daemon`,
`useRepoOpen`, `useDismissable`, `useUrlSync` are consumed as they are.
Two invariants carry over: `repoStore.open()` stays the sole `POST /repos`,
and every open gesture calls `beginUserNav()` **before** the state changes.
One refinement to the second: a probed open passes
`beginUserNav({ repo: probe.root })`, not the typed string. The old form
passed the raw input and its own comment records the consequence — a daemon
normalization "misses the match and the open replaces instead of pushing", so
for a bare container, where the opened root is never the typed path, the open
never got a history entry. The probe already knows the root `POST /repos`
will return, so this is free.

### Tests

**Break and are rewritten:** `RepoSwitcher.test.ts` and `App.test.ts`.

`RepoSwitcher.test.ts`'s `open-repos` / `discovered-repos` / `recent-repos`
group structure, the `4 worktrees` badge inside `open-repos`, and the whole
discovered-filter block (threshold at 8, substring narrowing) assert exactly
what this redesign removes. Do the rewrite as a **checklist pass against the
old file**, not from scratch. These contracts must survive, each re-asserted
at **component** level against the new DOM (row-builder unit tests are cheaper
but cannot catch a wrong click target):

1. pending recents are held back — no stray row per worktree;
2. sibling worktrees fold to one row, and clicking it `POST`s `/repos` with
   the **freshest** worktree path, not the clicked literal;
3. a recent already covered by an open project never appears twice;
4. a failed worktree lookup renders by its own path and is retried when the
   needed-paths watcher fires again, never cached dead;
5. an absent path is dropped;
6. mounting the picker triggers `POST /discovered/rescan`;
7. an open repo never repeats among discovered rows — **including a bare
   layout where one worktree is open and a sibling worktree is discovered:
   exactly one row for the family, zero discovered leaks**;
8. clicking a discovered row `POST`s `/repos` with its path.

`RepoSwitcher.test.ts` keeps only the popover-level cases (trigger label,
open/close).

`App.test.ts`'s repo-selection tests drive the old form through the empty
state (`[data-testid="empty-state"] form`, `setValue`, `trigger('submit')`).
There is no `<form>` and no submit any more, and Enter only opens once the
probe has answered, so a selector swap cannot fix them. Its checklist: add
`GET /resolve` to the fake fetch (plus the `/discovered/rescan` and
`/worktrees` calls the embedded picker makes), open either by settling the
probe and advancing the 250 ms debounce before Enter or by clicking a row,
and keep both existing contracts — **exactly one `POST /repos`**, and **a
refusal keeps the empty state**.

`RepoPicker.test.ts` adds: probe-gated button (fake `resolvePath`), debounce
and stale-guard, the `answeredFor` disarm (edit after an `openable` answer →
no button, Enter does not open), a 4xx answer rendering as `not a git
repository`, Enter rules including the no-op while checking and the
selection-moved override, reveal expand and its count/cap label, a filter
reaching discovered rows, the note-slot precedence (connection line, open
error, probe), and keyed selection surviving a late worktree resolution.
**Two-stage Escape is tested by mounting `RepoPicker` inside a small
`useDismissable` shell** — mounting the picker alone would pass while the real
panel closes, which is exactly the wrong-target failure the row contracts
above guard against.

**Deleted:** `RepoOpenForm.test.ts`.

**Added:** in `packages/daemon/src/repoOpen.test.ts`, a `GET /resolve` block
over one fixture set — normal repo root, subdirectory, bare container, `.bare`
directory, nonexistent path under a repo, plain directory, and a **negative**
`~` path — asserting the verdicts, plus a drift guard: for every fixture where
`openable` is true, `POST /repos` succeeds and returns the same root. The
positive `~` case lives in `args.test.ts` beside the existing child-process
`~` open test, which is the only place with a repointed `HOME`; that file's
`~` open gets a `GET /resolve` assertion for the same path. The shared
resolver makes drift nearly impossible, but the guard is cheap insurance and
stays. `packages/client/src/client.test.ts` gets `resolvePath`.

**Must stay green, untouched:** `worktrees.test.ts`, `ui.test.ts`,
`settings.test.ts`, `useDismissable.test.ts`, `useTextFilter.test.ts`,
`DirectoryPicker.test.ts`, `SettingsOverlay.test.ts`, `AppHeader.test.ts`,
`WorktreeSwitcher.test.ts`.

### Step order

Each step leaves the tree buildable and green, and no step leaves two ways to
open a repo in the tree at once.

1. **Core:** `resolveRepoRoot()` + `listWorktreesRaw()` + widen
   `pickDefaultWorktree`; `openRepo` switches onto the shared resolver.
   Existing tests cover the callers.
2. **Daemon:** `GET /resolve` + its tests + the drift guard + README row.
3. **Clients:** `resolvePath()` on both clients + client test.
4. **Row builder:** `repoPickerRows.ts` + its unit tests. Nothing renders it
   yet.
5. **Picker:** `RepoPicker.vue` on top of the builder, with its tests. Still
   not mounted anywhere.
6. **Swap and delete, one commit:** `RepoSwitcher.vue` and
   `RepoEmptyState.vue` switch to `RepoPicker`; `RepoOpenForm.vue`, its test,
   the old group template and the discovered filter are deleted; the
   `style.css` note is rewritten; `RepoSwitcher.test.ts` and `App.test.ts` are
   rewritten by their checklists. This is the only step where behaviour
   changes, and after it no old path exists.
7. **Changelog** entry: the redesign, the dropped prefill, and the empty
   state's recents now waiting on worktree resolution.

---

## 9. Open question

**Should the panel remember the expanded state across openings?** The spec
resets it every time, because the short default list is the requirement. If
the user's habit turns out to be expand-every-time, persisting it in prefs is
three lines — but then the default is no longer short.
