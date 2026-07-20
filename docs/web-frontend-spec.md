# diffstalker web frontend — specification

Phase 5 of the daemon split (`~/.claude/plans/buzzing-hugging-pinwheel.md`). This is the full
spec for `@diffstalker/web`: a browser client for `diffstalkerd` that mirrors every CLI feature
but is laid out for a real screen, not an 80-column terminal.

Last reviewed: 2026-07-20.

---

## 1. Goals

- **Full CLI parity.** The five base views — Diff, Commit, History, Compare (PR), Explorer —
  and every operation the daemon supports (staging, hunk staging, commit/amend, history
  cherry-pick/revert, compare base selection, and the remote/branch ops the CLI backend already
  exposes but never bound: push/fetch/pull/stash/branch switch+create/soft-reset/abort/rebase-continue).
- **Web-native, not a terminal port.** Exploit the extra real estate: persistent multi-pane
  layouts instead of tab-switching, always-visible controls, GitHub-style side-by-side diffs, a
  proper source-control panel where Diff + Commit live together.
- **One backend, no new git.** The web client is a pure `diffstalkerd` client over the same REST +
  SSE surface the CLI uses. No git logic in the browser.
- **Same live behavior.** Live status over SSE, on-demand diffs, follow mode, per-hunk edit times,
  word-level diff highlighting, fuzzy file finding — all carried over.

Non-goals (for now): auth, multi-user, remote/non-localhost exposure (see §14).

---

## 2. Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Framework | **Vue 3 + `<script setup>` + TypeScript** | Reactivity maps cleanly onto the SSE store; user's fluency. |
| Build tool | **Vite** | Static SPA build the daemon serves; HMR dev server with API proxy. |
| State | **Pinia** | Stores mirror the CLI's `RepoSession`/daemon-scope split. |
| Shared logic | **Extracted for reuse** (see §5) | DRY; one copy of the pure row/diff/tree/format logic. |
| Delivery | **Read-only first, then mutations** | De-risk transport + store + rendering before wiring writes. |
| Served by | **The daemon, at `GET /`, same-origin** | Daemon has no CORS and no auth; same-origin sidesteps both. |
| Transport | **Browser-native `fetch` + `EventSource`** | The existing `@diffstalker/client` transport is Node-only (see §4). |
| Published? | **No — bundled into `diffstalkerd`** (see §13) | Keeps the release at two published packages; assets ship inside the daemon. |

---

## 3. Architecture

```
Browser (Vue SPA, served by daemon at GET /)
  ├─ transport/        fetch (REST) + EventSource (SSE), same-origin, relative URLs
  ├─ stores (Pinia)
  │    ├─ daemonStore  open repos, follow-mode, connection status   ← GET /events
  │    └─ repoStore    one active repo: shared state + selection     ← GET /repos/:id/events
  ├─ composables       useDiff, useFuzzyFinder, useKeyboard, useTheme, ...
  ├─ components        views + widgets (Vue SFCs)
  └─ @diffstalker/core/view/*   shared pure logic (row building, word diff, tree, format)
        ▲ same modules the CLI uses
        │
diffstalkerd (--port N)
  ├─ REST + SSE over @diffstalker/core   (unchanged)
  └─ static file route → serves the built web SPA (new; see §12)
```

- The browser **cannot** reach the default unix socket and the daemon sends **no CORS headers**,
  so the SPA must be **same-origin** with the daemon. The daemon therefore serves the built assets
  itself, and must be launched with `--port N` (a browser can't use `--socket`).
- The browser **cannot spawn a daemon** (no `ensureDaemon` equivalent). The page is served by a
  live daemon; if that daemon dies, the SPA reconnects when it returns but never respawns it. This
  is the one behavioral difference from the CLI's reconnect story.

### Data flow (mirrors `RepoSession`)

1. **Shared state** (status, hunk counts, stash list, in-progress op, error) is pushed over the
   per-repo SSE channel (`snapshot` on connect, then `state-change`) and also returned inside every
   mutation envelope. A single `applyWireState(wire)` sink feeds both — exactly as `RepoSession`
   does — so a post-mutation snapshot reconciles selection.
2. **Selection** (the picked file + its diff) is per-client, fetched on demand via `GET …/diff`
   with a **20 ms leading+trailing debounce and an identity stale-guard** (ported verbatim from
   `RepoSession.scheduleDiffFetch`).
3. **History / compare** are pulled on demand and re-pulled on `state-change` when already loaded.
4. **Remote-op progress** is synthesized locally around the mutation call (there is no remote SSE
   channel), driving the header's `pushing…/rebasing…/…` state machine.

Everything the components read is synchronous reactive state; nothing hands a component a promise.
Errors collapse into `repoStore.error` (shown in the header), never thrown into the view.

---

## 4. Transport layer (browser)

`@diffstalker/client`'s method surface, wire types, and revival/reconnect *logic* are reused, but
its `transport.ts` is **Node-only** (`node:http`, unix sockets, `Buffer`, a hand-rolled SSE
parser) and cannot run in a browser. The web package ships its own thin transport with the same
shape, so the client method surface can be reused (ideally by refactoring `DiffstalkerClient` to
accept an injected transport interface; otherwise a small parallel client in web).

- **REST:** `fetch(path, { method, headers, body })` against **relative URLs** (same-origin). A
  non-2xx response body is `{ error }` → throw a `DaemonError { status, message }`. Any network
  failure → a connection error (mirrors `isConnectionError`). Decode: ISO-string dates →`Date`
  (`CommitInfo.date`, `CompareDiff.commits[].date`); `hunkCounts.staged/.unstaged` arrive as plain
  `{ path: number }` objects (no Map needed in the browser).
- **SSE:** native **`EventSource`** — a big simplification over the CLI's hand-rolled parser.
  `es.addEventListener('snapshot' | 'state-change', …)` for the per-repo channel and
  `'snapshot' | 'repo-opened' | 'repo-closed' | 'follow-change'` for `/events`. `EventSource`
  ignores the `: ping` keep-alive comments and auto-reconnects on drop for free.
- **Reconnect:** wrap `EventSource`; on `error`/drop set the one calm
  `daemon connection lost — reconnecting…` banner (guarded, no flicker) and, since the browser
  can't respawn the daemon, just retry the connection. On reconnect, re-`POST /repos` (the
  path-hashed id is stable across a daemon restart, so a restarted daemon re-yields the same id),
  resubscribe, and pull a fresh `status` snapshot — which clears the banner. Single-flight, like
  `RepoSession.recover`, minus the `ensureDaemon` spawn step.

The mutation envelope distinction carries over: staging ops return `{ state }` only; remote/branch/
undo ops return `{ state, result }` where `result` is the human-readable outcome string.

---

## 5. Shared pure-logic extraction

The CLI holds ~15 framework-agnostic modules the web client needs. They move into **`@diffstalker/core`
under a new pure subpath `@diffstalker/core/view/*`** (a presentation-logic layer peer to `git/`,
`utils/`, `services/`, `types/`). Rationale: core is already the monorepo's shared bundled library —
the CLI already imports pure helpers from it (`git/diff` parsers, `git/explorerData`, `utils`,
types) without pulling `simple-git`, enforced by dependency-cruiser and subpath imports. A dedicated
`@diffstalker/shared` package is the alternative if a harder boundary is wanted, but it adds a fifth
package's config for no new isolation the subpath rule doesn't already give. Either way the code is
**bundled** into both the CLI and the web build (like `core`/`client` today), not published.

**Extracted in Slice 1** — the ANSI-free closure moved to `@diffstalker/core/view/*`:

| Module | What it gives the web client |
|---|---|
| `wordDiff.ts` | `computeWordDiff`, `areSimilarEnough` — word-level highlight segments. |
| `fileTree.ts` | `buildFileTree`, `flattenTree` — compare/explorer tree building. |
| `flatFileList.ts` | flat/dedup partially-staged file rows. |
| `fileCategories.ts` | Modified/Untracked/Staged grouping. |
| `diffFilters.ts` | displayable-diff-line filtering. |
| `lineBreaking.ts` | `breakLine`, `getLineRowCount` — wrap math. |
| `diffRowCalculations.ts` | diff row/line helpers. |
| `formatPath.ts` | `shortenPath` (middle-ellipsis). |
| `formatDate.ts` | `formatRelativeTime`, `formatDate`. |
| `commitFormat.ts` | commit metadata formatting. |
| `languageDetection.ts` | `getLanguageFromPath` — pure map only. The emphasize/ANSI highlighters split out to `cli/utils/syntaxHighlight.ts`; the CLI's availability filter (`getSupportedLanguage`) also lives there, so core stays browser-pure while CLI output is unchanged. |
| `hunkTimes.ts` | already in `core/git` — `HunkTimeTracker`, `hashHunkBody` (per-hunk edit times). |

**Deferred to a later "de-ANSI" slice** (before the web diff/explorer views need them): `displayRows.ts`
and `explorerDisplayRows.ts` stayed in the CLI because they currently *bake ANSI syntax highlighting
into their row content* (they call the emphasize highlighters). To share them, highlighting must first
become injectable — the row builders should carry `{ content, language, wordDiffSegments }` and let each
frontend (blessed for CLI, DOM for web) apply highlighting. Until then the web builds diff rows on the
extracted primitives above, or waits for that refactor.

**Not extracted** (CLI-specific): `state/UIState.ts`, `state/FocusRing.ts`, `state/ExplorerViewModel.ts`
— these encode terminal focus-zone/pane navigation. The web builds its own equivalents (Pinia stores +
DOM focus), reusing only the pure computations above.

The extraction touches the shipped 0.5.1 CLI's imports (paths change from `../utils/x` to
`@diffstalker/core/view/x`). Gate it on the full CLI test suite before moving on — behavior-preserving
move, no logic change. Move each module's `*.test.ts` with it.

---

## 6. Web-native layout

The CLI is a two-pane (top/bottom) tab-switcher because it has one 80×24 grid. The web has room to
show more at once. Overall shell:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ HEADER  repo ▾   branch → origin/branch ↑2 ↓0   [fetch][pull][push]  ●op   │  ← global bar
│                                              follow● · theme ▾ · finder ⌘P │
├──────┬────────────────────────────────────────────────────────────────────┤
│ RAIL │  MAIN WORKSPACE (per active view)                                    │
│      │                                                                      │
│  ◧   │                                                                      │
│  Cha │                                                                      │
│  His │                                                                      │
│  Cmp │                                                                      │
│  Exp │                                                                      │
├──────┴────────────────────────────────────────────────────────────────────┤
│ STATUS BAR   connection ●  · follow: ~/.cache/…/target  · N changed         │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Header (global, always visible):** repo switcher, branch with tracking/ahead/behind, the
  remote-op action buttons the CLI never bound (`fetch`/`pull`/`push`, and stash/branch via a menu),
  live remote-op status (the `RemoteOperationState` machine: yellow `pushing…`, red error, green
  `lastResult`), follow-mode indicator, theme switcher, and the fuzzy finder trigger.
- **Activity rail (left, narrow):** switches the primary view. Four entries — **Changes** (Diff +
  Commit merged), **History**, **Compare**, **Explorer**. Commit stops being its own tab.
- **Status bar (bottom):** connection health, follow target, change counts.
- **Resizable panels** (splitpanes), sizes persisted to `localStorage` (the web analog of the CLI's
  `splitRatio`, but per-panel).

### 6.1 Changes view (Diff + Commit merged) — the source-control panel

The biggest web win: don't make staging and committing separate tabs. Three columns, like VS Code
Source Control / GitHub Desktop:

```
┌─ Files ─────────┬─ Diff (selected file) ───────────────┬─ Commit ───────────┐
│ ▾ Unstaged (3)  │  path/to/file.ts        [stage file] │ ┌────────────────┐ │
│   M file.ts  ●2 │  ┌ @@ hunk  5 min ago      [stage] ┐ │ │ message…       │ │
│   A new.ts      │  │  12  12   context                │ │ │                │ │
│ ▾ Staged (1)    │  │  13     - old      (word-diff)   │ │ └────────────────┘ │
│   M other.ts ●1 │  │      14 + new                    │ │ [ ] amend          │
│ [stage all]     │  └ … per-hunk stage/unstage gutter ┘ │ 1 file staged      │
│ [unstage all]   │                                       │ [ Commit ⌘↵ ]      │
└─────────────────┴───────────────────────────────────────┴────────────────────┘
```

- **Files column:** grouped Modified → Untracked → Staged (`fileCategories`), each row with a
  status glyph, per-file hunk counts (`●staged/total`), `+/−` stat, and inline stage/unstage/discard
  affordances. A flat/dedup mode toggle (the CLI's `h`) collapses partially-staged files into one
  row with a `[~]` partial control. Newest-changed file **flashes** (CSS animation) in follow/auto mode.
- **Diff column:** the shared `DiffView` component (§7). Working-tree diffs get the **hunk-staging
  gutter** — per-hunk stage/unstage buttons (the CLI's `s`/`u` on the focused diff), sending the
  extracted patch to `POST …/stage-hunk`. Word-level highlighting on changed add/del pairs. Per-hunk
  edit times; fresh hunks (< 1.5 s) flash.
- **Commit column (always visible):** message textarea (multi-line; commit on ⌘/Ctrl+Enter — no
  invisible-newline trap since it's a real `<textarea>`), amend checkbox (prefilled from
  `GET …/head-message`), staged-count summary, commit button. This is full parity with the CLI's
  Commit tab, but you never leave the diff to write the message.

### 6.2 History view

```
┌─ Commits ───────────┬─ Files in commit ──┬─ Diff ──────────────────────────┐
│ ▸ a1b2c  message    │  M src/foo.ts      │  (selected file's commit diff)  │
│   author · 2d ago   │  A src/bar.ts      │                                 │
│   [cherry-pick][rv] │  D old.ts          │                                 │
└─────────────────────┴────────────────────┴─────────────────────────────────┘
```

Three columns (commit list → files in that commit → diff), GitHub's commit-view shape. Commit rows
show hash, first-line message, author, relative date, ref/branch tags. Per-commit actions:
**cherry-pick** and **revert** (with a confirm), hitting `POST …/cherry-pick` / `…/revert`. Diffs
come from `GET …/commits/:hash/diff`. `count` is pageable (default 100) — add "load more".

### 6.3 Compare (PR) view — GitHub-style

```
┌─ base: origin/main ▾   [ ] include uncommitted   12 files  +340 −120 ──────┐
├─ Commits (5) ▸ ─────────────────────────────────────────────────────────────┤
├─ Files ▾ ────────────┬─ Diffs (unified ▾ / split) ─────────────────────────┤
│  ▾ src/              │  ▸ src/foo.ts   +40 −10                    [collapse]│
│    M foo.ts  +40 −10 │  ┌───────────────────────────────────────────────┐  │
│    A bar.ts  +20     │  │  diff …                                       │  │
│  D old.ts   −30      │  └───────────────────────────────────────────────┘  │
│  * dirty.ts [uncmt]  │  ▸ src/bar.ts   +20                                  │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

The PR-review view, done properly:
- **Base selector** (`GET/PUT …/compare/base`, candidates from `GET …/base-branches`) and the
  **include-uncommitted** toggle (re-queries `GET …/compare?uncommitted=`), both persistent at the top.
- **Stats** header (`filesChanged`, `+additions −deletions`).
- **Collapsible commits** section (`CompareDiff.commits`).
- **File tree** (left) built with `fileTree`, status icons (`+ ● − →`), per-file `+/−`, uncommitted
  files flagged magenta `[uncommitted]`.
- **Diffs** (right): file-by-file like a GitHub PR, each with a sticky header, collapsible, and a
  **unified / side-by-side toggle** (§7). Clicking a file in the tree scrolls to its diff.
- Distinct empty state when there's **no remote base branch** (base detection uses remote refs only),
  prompting base selection.

### 6.4 Explorer view

```
┌─ Tree ──────────────┬─ File ───────────────────────────────────────────────┐
│ ▾ src/              │  src/foo.ts                              1.2 KB · ts  │
│   ▾ ui/             │   1  import { x } from './x'                          │
│     M Header.vue ● │   2                                                    │
│   M foo.ts          │   3  export function foo() {                          │
│ ▸ node_modules/     │   …  (syntax-highlighted, line numbers)               │
└─────────────────────┴──────────────────────────────────────────────────────┘
```

VS Code-style explorer: collapsible tree (`GET …/tree?dir=`) with git-status decorations
(status letters, `●` on dirs with changes), lazy dir loading, a changed-only filter (the CLI's `g`),
and dotfile/ignored toggles (note the daemon's `hidden`/`ignored` query params are **inverted** from
the core options — `hidden=false` hides dotfiles). File pane (`GET …/file?path=`) renders
syntax-highlighted content with line numbers and explicit binary / truncated / too-large states
(the daemon returns `{ content, binary, truncated, tooLarge, size, totalLines }` — render from the
flags, don't parse prose).

### 6.5 Fuzzy finder (global, ⌘/Ctrl+P)

An overlay palette over `GET …/files`, using the same **`fzf`** library the CLI uses (`fzf-for-js`
runs in the browser — smart-case, word-boundary aware). Debounced input, highlighted match runs,
keyboard nav. Selecting a file opens it in the current view (reveals it in the Explorer tree, or
selects it in Changes). Room to grow into a full command palette later.

---

## 7. Diff rendering component

A single shared `DiffView` SFC powers Changes, History, and Compare. Its row model comes from the
extracted `displayRows` builders (single source of truth for layout **and** virtual-scroll bounds).
The CLI's `DiffView` emits raw ANSI; the web reimplements only the **emitter** as DOM:

- **Layout:** a line-number gutter (old / new columns), a `+/−/space` symbol column, and a content
  column of spans. Add/del backgrounds and changed-word highlights are CSS classes bound to theme
  vars (§8), replacing the ANSI SGR runs.
- **Word-level highlight:** `computeWordDiff` segments; changed runs get a `.word-changed` span with
  the darker highlight background.
- **Unified + side-by-side:** unified is the default (matches the CLI); side-by-side is a per-view
  toggle for the Compare/PR view (two synced columns). Both consume the same row model.
- **Hunk staging gutter** (Changes only, working-tree diffs): a per-hunk control column with
  stage/unstage buttons; the client extracts the hunk's patch and POSTs it. Selected-hunk highlight
  and keyboard hunk-nav (`n`/`N`) carry over.
- **Per-hunk edit times:** `HunkTimeTracker` output rendered in each hunk header ("5 minutes ago");
  sub-minute values tick every second; hunks changed within 1.5 s flash.
- **Performance:** diffs and file lists can be large — **virtualize** long lists (only render rows in
  view). The row-count builders make this exact. Recommended: a virtual scroller (e.g.
  `vue-virtual-scroller`) or a small custom windowing composable over the row model.
- **Syntax highlighting:** the Explorer (and optionally diff content) uses **highlight.js** in the
  browser (lighter than Shiki; shares `getLanguageFromPath`). Shiki is a later upgrade if
  theme-accurate TextMate highlighting is wanted.

---

## 8. Theming

Carry the **6 themes** (`dark`, `light`, `dark-colorblind`, `light-colorblind`, `dark-ansi`,
`light-ansi`) as **CSS custom properties**. The CLI's `DiffColors` (10 fields: `addBg`, `delBg`,
`addHighlight`, `delHighlight`, `text`, `addLineNum`, `delLineNum`, `contextLineNum`, `addSymbol`,
`delSymbol`) become `--diff-*` vars. Additionally **promote the literals the CLI scatters across
widgets** (file-status colors, selection cyan, header/border colors, magenta-uncommitted, flash
yellow) to their own vars, so the web is fully themeable rather than half-hardcoded. A `data-theme`
attribute on `<html>` selects the palette; a theme switcher in the header persists to
`localStorage`. Honor `prefers-color-scheme` for the initial dark/light default. The two `*-ansi`
themes map to a terminal-palette set of vars.

Client-side preferences (theme, panel sizes, view toggles, recent repos) live in `localStorage` —
the browser analog of the CLI's `~/.config/diffstalker/config.json`. Daemon-side config (open repos,
follow target) stays daemon-side.

---

## 9. Live updates, SSE, reconnect

- **Two subscriptions:** `daemonStore` opens `GET /events` (open-repo list, `repo-opened`/`repo-closed`,
  `follow-change`); `repoStore` opens `GET /repos/:id/events` per active repo (`snapshot` +
  `state-change`, shared state only — diffs are pulled).
- **`applyWireState`** is the single sink for SSE `snapshot`/`state-change` **and** every mutation
  envelope's `state`, so selection re-anchors after a mutation (the daemon guarantees
  mutation-ack-before-refresh ordering per repo).
- **Cascade on `state-change`:** re-fetch the selected file's diff (debounced), and re-pull
  history/compare if they were already loaded.
- **Follow mode:** `daemonStore` reacts to `follow-change` and switches the active repo/file, same
  policy as the CLI's `FollowMode`. A follow indicator sits in the header/status bar.
- **Reconnect:** §4 — banner + retry, no daemon respawn (browser can't). Stable path-hashed ids make
  re-open transparent.

---

## 10. Interaction model

- **Mouse-first, keyboard-capable.** Everything is clickable (web expectation), but the CLI's
  power-user keys carry over via a `useKeyboard` composable: `j/k`/arrows to move, `n/N` hunk nav,
  stage/unstage/discard/commit shortcuts, `1–4` to switch views, `⌘/Ctrl+P` finder, `?` help. DOM
  focus replaces blessed focus-zones; `Tab` follows natural document order plus explicit roving-tabindex
  within lists.
- **Modals → web dialogs/panels:** the CLI modals become web equivalents — repo picker, worktree
  picker, base-branch picker, theme picker, discard confirm, commit-action (cherry-pick/revert)
  confirm, hotkeys help, fuzzy finder. Focus-trap + Esc-to-close, accessible (`role="dialog"`,
  `aria-modal`).
- **Repo selection in a browser:** unlike the CLI, the browser can't easily browse the server
  filesystem. MVP: the repo switcher lists **open repos** (`GET /repos`) plus the follow-mode repo,
  and offers a **text field to open a repo by absolute path** (`POST /repos`). A web recent-repos
  list lives in `localStorage`. A server-side directory browser is a later nicety.

---

## 11. Operations (mutation phase)

Full set, all already supported by the daemon. Read-only phase ships none of these; the mutation
phase wires them all:

| Operation | Endpoint | Surfaced in |
|---|---|---|
| stage / unstage / stage-all / unstage-all | `POST …/stage` etc. | Changes files column |
| stage-hunk / unstage-hunk | `POST …/stage-hunk` (patch body) | Changes diff gutter |
| discard / delete untracked | `POST …/discard` | Changes files (confirm) |
| commit / amend | `POST …/commit` | Changes commit column |
| cherry-pick / revert | `POST …/cherry-pick` `…/revert` | History (confirm) |
| set compare base | `PUT …/compare/base` | Compare header |
| push / fetch / pull | `POST …/push` `…/fetch` `…/pull` | Header buttons |
| stash / stash-pop | `POST …/stash` `…/stash-pop` | Header menu / stash list |
| switch / create branch | `POST …/switch-branch` `…/create-branch` | Header menu |
| soft-reset | `POST …/soft-reset` | History / header menu |
| abort / rebase-continue | `POST …/abort` `…/rebase-continue` | Header, when an op is in progress |

The `push`/`fetch`/`pull`/`stash`/`branch`/`reset`/`abort`/`rebase-continue` ops are the ones the
CLI backend already exposes but never bound to keys — the web UI is the natural place to finally
surface them, since the `RemoteOperationState` header machine already renders their progress.
Remote-op progress is synthesized locally around the call (no remote SSE channel); `409` responses
(rejected push, conflicting pull/pop/cherry-pick, op-in-progress) surface as actionable errors, and
a mid-rebase/mid-cherry-pick state exposes **abort** / **continue**.

---

## 12. Build & serving

- **Package:** `packages/web` (`@diffstalker/web`, private). Vite + Vue + TS. Builds to a static
  `dist/` (`index.html` + hashed JS/CSS assets), no SSR.
- **Dev:** `vite dev` with a proxy forwarding `/health`, `/repos`, `/events`, `/follow` (REST + SSE)
  to a locally running `diffstalkerd --port N`. HMR for the SPA; the daemon runs unchanged.
- **Serve in production:** the daemon gains a **static-file route**. The existing method+path router
  matches API routes first; a fallback handler serves `index.html` for `GET /` and unmatched non-API
  GET paths (SPA fallback) and hashed assets from the web `dist/`. Care: API prefixes
  (`/health`, `/repos`, `/events`, `/follow`) must win over the static fallback. SSE and JSON routes
  are unaffected.
- **How assets reach the daemon:** a root build step builds `@diffstalker/web` and places its `dist/`
  where the daemon serves it (copied into the daemon package's servable dir, or served from the
  web package's `dist` in dev). The web `dist` ships **inside the published `diffstalkerd` tarball**
  (`files` allowlist), the same "bundled, not separately published" pattern as `core`/`client`.

---

## 13. Packaging & release

The web UI does **not** become a third published npm package. It's a private package **bundled into
`diffstalkerd`**: the daemon serves the built SPA, so the assets ship inside the daemon's tarball.
The release stays **two lockstep published packages** (`diffstalker` + `diffstalkerd`). Versioning is
single-sourced (Slice 2.5): the root `package.json` is the version source, `release.sh` `MANIFESTS`
now carries root + cli + daemon, and the workflow's `PUBLISHABLE` is unchanged (still the two
published packages). `@diffstalker/web` is private and pinned at a static `0.0.0` like `core`/`client`.
The one release concern: `diffstalkerd`'s `build:prod` runs the web build first and copies it into
`dist/web` so `bun pm pack` includes it, and the daemon's `files` allowlist lists `dist/web`. The CI
pin-guard and lockfile patch (from the 0.5.1 fixes) are unaffected. Update `CHANGELOG.md`/`FEATURES.md` and
this doc as the web UI lands. (This revises the earlier "web = 3rd published package" assumption in
`release-model` — serving it from the daemon is simpler and keeps same-origin.)

---

## 14. Security

- **Same-origin only.** No CORS headers and no auth on the daemon today; serving the SPA from the
  daemon keeps everything same-origin. `EventSource`/`fetch` need this.
- **Localhost only.** `--port` binds `127.0.0.1` by default. Do **not** document exposing the daemon
  beyond localhost until the planned **bearer token + CORS** land (daemon `server.ts` TODO). If a
  user binds `--host 0.0.0.0`, the git-mutating REST surface is unauthenticated — out of scope for
  the MVP; flag loudly in docs.
- **Body limit** 1 MiB (daemon `413`); the web client keeps request bodies (e.g. hunk patches) small.

---

## 15. Testing

- **Shared logic:** already unit-tested; tests move with the modules into `core/view`. Run under the
  existing suite.
- **Web unit/component:** **Vitest** + `@vue/test-utils` / `@testing-library/vue` for stores,
  composables (diff debounce/stale-guard, `applyWireState`, reconnect), and key components
  (DiffView row rendering, file list grouping, fuzzy finder).
- **E2E (optional):** Playwright against a real `diffstalkerd --port N` on a temp repo — open a repo,
  assert the file list, stage via the UI, assert the SSE-driven update, commit. Same shape as the
  daemon's HTTP integration tests, from the browser.
- **No real daemon in unit tests:** stores/components drive a fake transport (like the CLI's fake
  `DiffstalkerClient`).

---

## 16. Phased roadmap

**Phase 5a — read-only MVP.**
1. Extract shared logic into `@diffstalker/core/view/*`; re-green the CLI.
2. Scaffold `packages/web` (Vite + Vue + Pinia + TS); daemon static-file route + `--port` serving.
3. Browser transport (fetch + EventSource) + `daemonStore`/`repoStore` (`applyWireState`, diff
   debounce/stale-guard, reconnect).
4. Shell (header, rail, status bar, theming) + repo selection.
5. The five views, read-only: Changes (files + diff, no staging), Commit (view staged, no submit),
   History, Compare/PR, Explorer. Live over SSE. Fuzzy finder. Follow mode.

*Verify:* daemon on `--port`, browser walks all five views live; edits on disk update via SSE; diffs,
history, compare-against-base, explorer + syntax highlight, fuzzy finder all work read-only.

**Phase 5b — mutations to parity.**
6. Staging (file + hunk), discard, stage/unstage-all.
7. Commit + amend.
8. History cherry-pick / revert; compare base set.
9. Remote/branch ops: push/fetch/pull/stash/branch/soft-reset/abort/rebase-continue, with the
   header progress machine and conflict (`409`) handling.

*Verify:* full FEATURES.md parity from the browser, side-by-side against the CLI.

**Phase 5c — web-native polish.** Side-by-side diff, virtualization tuning, command palette,
server-side repo browser, keyboard-shortcut help, accessibility pass.

---

## 17. Open questions / risks

- **Repo discovery in the browser** (§10): open-by-path is the MVP; a server-side directory browser
  needs a new daemon endpoint — defer unless it chafes.
- **Auth/exposure** (§14): only same-origin localhost is safe until bearer-token + CORS land. Anything
  networked is blocked on that daemon work.
- **Large-diff performance:** virtualization is required, not optional; validate on a big diff early.
- **Shared extraction risk:** it touches the shipped CLI's imports — behavior-preserving, gated on the
  CLI suite, but it's the one change that reaches into working code.
- **Side-by-side diff** reuses the unified row model but needs a paired-line layout; scope it in 5c,
  not the MVP.

---

## Appendix — view → daemon endpoints

| View | Reads | Live | Mutations (5b) |
|---|---|---|---|
| Changes | `GET …/status`, `GET …/diff?path=&staged=`, `GET …/head-message` | `…/events` `state-change` | `stage`/`unstage`/`stage-all`/`unstage-all`/`discard`/`stage-hunk`/`unstage-hunk`/`commit` |
| History | `GET …/history?count=`, `GET …/commits/:hash/diff` | re-pull on `state-change` | `cherry-pick`/`revert`/`soft-reset` |
| Compare | `GET …/base-branches`, `…/branches`, `GET/PUT …/compare/base`, `GET …/compare?base=&uncommitted=` | re-pull on `state-change` | `compare/base` (PUT) |
| Explorer | `GET …/tree?dir=&hidden=&ignored=`, `GET …/file?path=`, `GET …/files` | re-pull on `state-change` | — |
| Global | `GET /repos`, `GET /follow`, `POST /repos`, `DELETE /repos/:id` | `/events` `repo-opened`/`repo-closed`/`follow-change` | push/fetch/pull/stash/branch/abort/rebase-continue |

Wire notes: dates arrive as ISO strings (`→ new Date`); `hunkCounts.staged/.unstaged` are plain
`{ path: number }` objects; mutation envelopes are `{ state }` (staging) or `{ state, result }`
(remote/branch/undo); errors are HTTP status + `{ error }` body (no success envelope).
