# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository. Last reviewed: 2026-07.

## Project Overview

diffstalker is a terminal UI for interactive git staging and committing, built with TypeScript and neo-blessed.

The git state engine now lives in a **daemon** (`diffstalkerd`): a Node http server exposing `@diffstalker/core` over REST + Server-Sent Events. The terminal UI is a **client** of that daemon — it holds no in-process git. On launch the CLI attaches to a running daemon or spawns one on a unix socket, opens repos over REST, and follows live state over SSE. The daemon owns follow mode: it watches ONE hook file external tools append repo/file paths to, and broadcasts `follow-change` so clients can switch focus. The same daemon can back other clients (a web UI is planned).

## Feature Documentation

**IMPORTANT:** After adding a new feature, update `FEATURES.md` to document it. Keep the feature list organized by category (Views, Navigation, Operations, etc.).

## Tech Stack

- **TypeScript** with ESM modules, compiled with `tsc`, run with **bun** in development
- **Node `http`** for the daemon (REST + SSE over `@diffstalker/core`, no framework)
- **simple-git** for git operations — **core/daemon only** (the CLI never runs git in-process)
- **chokidar** for file watching (follow hook file, git dir, working tree) — **core/daemon only**
- **neo-blessed** for terminal rendering (CLI; patched at runtime for 24-bit RGB, see `packages/cli/src/utils/blessedRgbPatch.ts`)
- **fast-diff** for word-level diff highlighting (in `@diffstalker/core/view/wordDiff`, bundled into CLI + web)
- **emphasize** for syntax highlighting in the explorer (CLI)
- **fzf** for file finder matching (CLI)
- Event-driven state: Node `EventEmitter` inside the daemon (managers) and inside the CLI's `RepoSession` (no React)

## Build Commands

The repo has four packages (`packages/core`, `packages/daemon`, `packages/client`, `packages/cli`); root scripts delegate to them, so these all work from the repo root (`dev`/`start` target the cli):

```bash
bun run dev           # Run the CLI with bun --watch (development)
bun run build         # Clean dist/ and compile TypeScript (all packages)
bun run build:prod    # Build + minify the CLI's dist/index.js (what npm consumers get)
bun run start         # Run the compiled CLI
bun run test          # Run the full suite across all packages
bun run lint          # ESLint + dependency-cruiser (all packages)
bun run deps          # Dependency-cruiser only (all packages)
bun run metrics       # Code quality metrics report (scripts/collect-metrics.ts, all packages)
```

### Running

`diffstalker` (the CLI) auto-spawns the daemon: on launch it looks for a live `diffstalkerd` on the socket (`--socket PATH`, then `$DIFFSTALKER_SOCKET`, then `$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock`), attaches if one answers, and otherwise spawns one that outlives the TUI. The CLI never stops the daemon; on exit it just releases its repos (`DELETE /repos`, refcounted).

To run the daemon standalone (for a non-TUI client, or to keep it warm):

```bash
bun packages/daemon/src/index.ts            # development (source)
node packages/daemon/dist/index.js          # after bun run build
diffstalkerd --socket /path/to.sock         # explicit socket
```

By default the daemon binds a unix socket at `$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock` (dir `0700`, socket `0600`) and refuses to start if `XDG_RUNTIME_DIR` is unset; use `--socket PATH` or `--port N` to override. See `packages/daemon/README.md` for the full endpoint table and follow-mode notes.

## Releasing

Use `bun run release` to publish a new version. The **root `package.json` is the single source of version truth**: the script reads and bumps it, and derives the two published manifests (`diffstalker`, `diffstalkerd`) from it in lockstep (they must carry a literal version for npm). The three private, bundled packages (`@diffstalker/core`, `@diffstalker/client`, `@diffstalker/web`) stay at a static `0.0.0` and are never versioned — they ship inside the published bundles, not on their own. The script commits, tags, and pushes; it refuses to run if the working tree is dirty or if `CHANGELOG.md` has no entry for the new version. The pre-push hook runs the full test suite before the tag push is allowed through. CI then builds, tests, publishes to npm, and commits a metrics snapshot.

```bash
bun run release         # patch bump (0.3.0 -> 0.3.1)
bun run release:minor   # minor bump (0.3.1 -> 0.4.0)
bun run release:major   # major bump (0.4.0 -> 1.0.0)
```

Never bump `package.json` or create version tags manually — always use the script so the version, changelog, and tag stay in sync.

## Project Structure

The repo is a bun workspace with five packages:

- **`@diffstalker/core`** — headless git state (plain git fns + a small set of managers), no UI deps. The daemon consumes its managers; the CLI and web client import pure helpers/types from it (`view/*` presentation logic, `git/diff`, `git/explorerData`, `git/status`/`worktree` types, `services/commitService`, `utils`, `types`) but **not** its managers.
- **`@diffstalker/daemon`** — diffstalkerd, published to npm as a bin-only package (an executable, not an importable API): Node http REST + SSE over core. Owns git state and follow mode, and serves the web UI at `GET /`.
- **`@diffstalker/client`** — a typed REST + SSE client for the daemon. Private; consumed by the CLI (and, later, a web client).
- **`diffstalker`** (`packages/cli`) — the terminal UI, published to npm. A pure daemon client: `RepoSession` fed by REST + SSE, `DaemonLifecycle` to attach/spawn.
- **`@diffstalker/web`** — the browser UI (Vue 3 + Vite + Pinia): a pure daemon client over the same REST + SSE. Private; its built assets are bundled INTO the `diffstalkerd` tarball and served same-origin (not a separately published package). Phase 5, in progress.

The two **published** packages are `diffstalker` and `diffstalkerd`; the other three are private and bundled. See Releasing for the single-source version model.

Everything imports core via subpath imports only (e.g. `@diffstalker/core/git/status`) — there is no barrel/bare specifier. A dependency-cruiser rule forbids the CLI from importing `@diffstalker/core/managers/*`, `simple-git`, or `chokidar` (see Architecture Layering).

```
packages/core/src/
├── git/                    # Plain async functions wrapping simple-git / git CLI
│   ├── gitClient.ts        # Shared simple-git instance factory
│   ├── status.ts           # getStatus, stage/unstage, hunk staging, commits
│   ├── diff.ts             # Diff generation/parsing, hunk extraction (extractHunkPatch)
│   ├── explorerData.ts     # Tree listing + buildGitStatusMap for the file explorer
│   ├── hunkTimes.ts        # Per-hunk edit timestamps
│   ├── worktree.ts         # Worktree/bare-repo resolution and listing
│   └── ignoreUtils.ts      # Gitignore checking
├── managers/               # EventEmitter-based state managers (daemon-side only)
│   ├── GitStateManager.ts  # Thin coordinator: workingTree + remote per repo
│   ├── WorkingTreeManager.ts # Status+diff state, git/working-dir watchers ('state-change')
│   ├── RemoteOperationManager.ts # push/fetch/pull/stash/branch ops ('remote-state-change')
│   ├── GitOperationQueue.ts # Serializes git operations per repo, refresh scheduling
│   └── FilePathWatcher.ts  # Watches the follow hook file
├── services/
│   └── commitService.ts    # Git commit execution
├── view/                   # Pure presentation logic, shared by CLI + web (no UI/node/ANSI deps)
│   ├── displayRows.ts?     # (row builders like wordDiff, fileTree, flatFileList,
│   │                       #  fileCategories, diffFilters, lineBreaking, diffRowCalculations)
│   ├── formatPath.ts       # shortenPath, formatDate, commitFormat — pure formatters
│   └── languageDetection.ts # getLanguageFromPath (pure map; NO emphasize/ANSI — that stays in cli)
├── utils/                  # logger, path utils, base-branch cache, xdg dirs
└── types/                  # Shared type declarations (remote)
```

`view/` holds framework-agnostic presentation logic (diff/explorer row models, word diff, file-tree
building, formatters, language detection) extracted from the CLI so the CLI and the coming web client
share one copy. It imports git/ and utils/ **types only** (a runtime import would drag node-only code
into a browser bundle — a dependency-cruiser rule enforces this). Its ANSI counterpart (emphasize
highlighting) stays in `packages/cli/src/utils/syntaxHighlight.ts`; the row builders that bake ANSI in
(`displayRows`, `explorerDisplayRows`) also stay in the CLI until highlighting is made injectable.

The History, Compare, and Explorer **managers were deleted** in the daemon split. History/compare/explorer data are stateless now: the daemon serves them on demand with plain git fns (`git/status`, `git/diff`, `git/explorerData`) and holds no per-client selection or tree expansion.

```
packages/daemon/src/
├── index.ts                # Entry point: parseArgs, socket resolution, signals
├── server.ts               # createDaemon: http server, wiring, listen/close
├── router.ts               # Method+path router, JSON bodies, HttpError -> {error}
├── repoRegistry.ts         # Open repos by path, stable ids, refcounting, follow-ref
├── follow.ts               # Hook-file watcher -> resolve path -> open repo -> broadcast
├── sse.ts                  # Per-repo + daemon-scope SSE hubs fanning out events
├── serialize.ts            # Wire encoders (shared state, Dates/Maps to JSON)
└── routes/                 # One module per endpoint group
    ├── health.ts, repos.ts, workingTree.ts, remote.ts
    ├── historyCompare.ts, explorer.ts, daemon.ts, shared.ts

packages/client/src/
├── index.ts                # Public exports (DiffstalkerClient, wire types, isConnectionError)
├── client.ts               # DiffstalkerClient: typed methods for every endpoint + subscribe
├── transport.ts            # http-over-unix-socket / TCP fetch + SSE stream reader
└── wire.ts                 # Wire types + decoders (JSON dates/maps back to rich types)

packages/cli/src/
├── index.ts                # Entry point: CLI args, ensureDaemon, terminal cleanup, crash handlers
├── App.ts                  # Main controller: screen, RepoSession, listeners, render loop
├── daemon/
│   ├── DaemonLifecycle.ts  # ensureDaemon: resolve socket, attach or spawn diffstalkerd
│   └── RepoSession.ts      # Client-side store for one repo: SSE + on-demand pulls, reconnect
├── KeyBindings.ts          # All keyboard bindings (screen-level), KeyBindingActions interface
├── MouseHandlers.ts        # Mouse event handling against layout regions
├── NavigationController.ts # Selection movement, scrolling, hunk navigation
├── StagingOperations.ts    # Stage/unstage/toggle operations, pending selection intents
├── ModalController.ts      # Single source of truth for modal state (ModalType union)
├── FollowMode.ts           # Reacts to the daemon's follow-change SSE -> repo switching
├── config.ts               # Config loading/saving (~/.config/diffstalker/config.json)
├── themes.ts               # Theme definitions (6 themes)
├── ui/
│   ├── Layout.ts           # LayoutManager: blessed boxes, split ratio, pane sizing
│   ├── PaneRenderers.ts    # renderTopPane/renderBottomPane dispatch per tab
│   ├── widgets/            # Pure formatters returning strings for blessed boxes
│   │   ├── Header.ts, Footer.ts, FileList.ts, FlatFileList.ts, fileRowFormatters.ts
│   │   ├── DiffView.ts, HistoryView.ts, CompareListView.ts
│   │   ├── CommitPanel.ts, ExplorerView.ts, ExplorerContent.ts
│   └── modals/             # Modal implementations (Modal interface: destroy/focus)
│       ├── Modal.ts, ThemePicker.ts, HotkeysModal.ts, RepoPicker.ts
│       ├── WorktreePicker.ts, BaseBranchPicker.ts, DiscardConfirm.ts
│       ├── FileFinder.ts, CommitActionConfirm.ts
├── state/
│   ├── UIState.ts          # Panes, tabs, focus zones, selection indices, toggles
│   ├── CommitFlowState.ts  # Commit panel state machine
│   ├── ExplorerViewModel.ts # Explorer tree state, fed by daemon tree/file endpoints
│   └── FocusRing.ts        # Tab/Shift-Tab focus zone cycling
├── utils/                  # CLI-only helpers (displayRows, ansi, syntaxHighlight, layout math...)
└── types/                  # Shared type declarations (tabs, session, neo-blessed shim)
```

## Key Patterns

### Daemon-backed state (CLI)

The CLI holds no git. One `RepoSession` per open repo is the client-side store:

- **shared state** (status, hunk counts, stash list, in-progress op, error) is fed by the per-repo SSE stream (`GET /repos/:id/events`) and by mutation response envelopes (`{state, result?}`);
- **selection** (the picked file + its diffs) is per-client, fetched on demand via `GET /diff` with a 20ms debounce + stale-guard;
- **history and compare** are pulled on demand and re-pulled on `state-change` when previously loaded;
- **remote-operation progress** (cherry-pick/revert) is synthesized locally around the mutation call — there is no remote SSE channel.

`RepoSession` re-emits `state-change` / `history-change` / `compare-change` / `remote-change`; `App.ts` subscribes and calls `render()`, which re-renders panes via `PaneRenderers`. All getters return cached state synchronously (blessed renders synchronously) — nothing hands the UI a promise. Errors collapse into `shared.error` (surfaced in the header); they never throw to the UI.

**Reconnect:** when the SSE stream drops, the session sets one calm `daemon connection lost — reconnecting…` line in `shared.error` and retries in the background — it re-runs `ensureDaemon` (spawns a fresh daemon if the socket is gone), re-POSTs `/repos` (the path-hashed id is stable across a daemon restart), and resubscribes. A fresh snapshot clears the error.

### Daemon-side managers and events

Inside the daemon, `@diffstalker/core` keeps the EventEmitter managers: `GitStateManager` coordinates `WorkingTreeManager` (status+diff, git/working-dir watchers, `state-change`) and `RemoteOperationManager` (push/fetch/pull/stash/branch, `remote-state-change`) per repo. The daemon's per-repo SSE hub fans `state-change` out to clients. History, compare, and explorer have **no** managers — they are served statelessly from plain git fns. Never emit unsubscribed `'error'` events — an EventEmitter `'error'` without a listener crashes the process.

### Git Operations

Plain functions in `packages/core/src/git/` wrap simple-git. Mutations go through `GitOperationQueue` (one queue per repo) so operations serialize and refreshes coalesce; daemon route handlers call the owning manager (e.g. `WorkingTreeManager.stageFile`), which updates state and surfaces errors instead of crashing, then respond with the `{state, result?}` envelope. `getStatus` returns `isRepo: false` only for a genuine non-repo; other failures propagate to keep the previous status visible.

### Modals

All modal state lives in `ModalController` (single source of truth):

- `ModalType` union identifies which modal is open; each modal implements the `Modal` interface (`destroy()`, `focus()`) from `src/ui/modals/Modal.ts`
- Toggle pattern: if `getActiveModalType() === 'type'` then `closeActiveModal()`; else check the `hasActiveModal()` guard, then open
- `closeActiveModal()` must call `ctx.render()` after destroying the blessed widget, otherwise visual artifacts remain
- Trigger keys (like `?` for hotkeys, `r` for repo picker) are handled at screen level in `KeyBindings.ts`, NOT in modal box key handlers — box-level handlers fire before screen-level ones but both fire, so a box handler that destroys the modal lets the key fall through to a screen handler that no longer sees an active modal
- `q` is guarded by `hasActiveModal()`; `C-c` always exits

### Keyboard and Mouse

`setupKeyBindings` receives a `KeyBindingActions` interface (implemented by App) and a read-only `KeyBindingContext`. Adding a binding means: handler in `KeyBindings.ts`, action wired in `App.setupKeyboardHandlers()`, hint in `Footer.ts` and `HotkeysModal.ts`. Mouse events are handled in `MouseHandlers.ts` against `LayoutManager` regions; terminal mouse coordinates are 1-indexed.

### Single Source of Truth for Row Calculations

When building UI structures with rows (diff views, file lists), always use a single exported function to build/count rows, used by both rendering and scroll calculations. Example: `buildDiffDisplayRows()` / `wrapDisplayRows()` / `getHunkBoundaries()` in `src/utils/displayRows.ts` feed `DiffView.ts` rendering AND the scroll-bounds math in App. Never duplicate row-counting logic inline — scroll limits and click detection go subtly wrong when render adds headers the counter doesn't know about.

### Terminal Cleanup

`index.ts` registers handlers for `exit`, `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`. Cleanup leaves the alternate screen buffer first so crash diagnostics land on the normal buffer, then disables mouse modes and restores the cursor.

## Common Tasks

### Adding a new git operation
1. Add the plain function to `packages/core/src/git/status.ts` (or `diff.ts`/`worktree.ts`)
2. Add a method on the owning manager in `packages/core/src/managers/` that runs it through the queue and updates state with error handling (only when the op needs live/queued state; stateless reads stay plain fns)
3. Add a daemon route in `packages/daemon/src/routes/` that calls it and returns the `{state, result?}` envelope
4. Add a typed method to `DiffstalkerClient` in `packages/client/src/client.ts`
5. Call it from `RepoSession` (apply the returned envelope) and wire it from `App.ts` (action) + `KeyBindings.ts` (key)

### Adding a keybinding
1. Add handler in `src/KeyBindings.ts` (respect the `hasActiveModal()` guard for non-modal keys)
2. Add the action to `KeyBindingActions` and implement it in `App.setupKeyboardHandlers()`
3. Update `Footer.ts` and `ui/modals/HotkeysModal.ts` to show the hint, and FEATURES.md

### Adding a modal
1. Create a class in `src/ui/modals/` implementing the `Modal` interface
2. Add its `ModalType` and an `openX()` method in `ModalController.ts` (follow the toggle/guard pattern)
3. Trigger from `KeyBindings.ts` at screen level
4. Render happens via `ctx.render()` on close — do not skip it

## Gotchas

- Blessed: after `box.destroy()`, the screen must be explicitly re-rendered to clear visual artifacts
- Blessed: box-level key handlers fire before screen-level ones when the box has focus — but both fire (see Modals above)
- `setImmediate` hacks for race conditions are a code smell — use proper guards at the KeyBindings level
- Mouse coordinates from terminals are 1-indexed
- `simple-git` status may include gitignored files in some cases; we filter with `git check-ignore` (core/daemon)
- neo-blessed truecolor only works because of the runtime patch (`applyBlessedRgbPatch()` runs before screen creation); content SGR `38;2;R;G;B` codes are otherwise downsampled (CLI)
- Core/daemon tests must not create real chokidar watchers: construct `WorkingTreeManager` without calling `startWatching()`, and construct the daemon with follow disabled (or point `--follow-file` at a temp path). CLI tests spin up no watchers — the daemon owns them.
- CLI tests must not hit a real daemon: `RepoSession`/`App` tests drive a fake `DiffstalkerClient`; `DaemonLifecycle` tests point at a throwaway socket and tear it down with `fuser -k <socket>` (never `pkill diffstalkerd` — that kills the user's live daemon)

## Code Quality Guidelines

### Pre-commit Hook

A pre-commit hook runs `bun run lint` (ESLint + dependency-cruiser) before every commit. It lives in `.githooks/pre-commit` and is activated via the `prepare` script after `bun install`. 19 pre-existing sonarjs cognitive-complexity warnings are expected (8 in packages/core + 11 in packages/cli; daemon and client 0), 0 errors.

### Architecture Layering (dependency-cruiser)

Each package has a `.dependency-cruiser.cjs` enforcing that lower layers do not import higher layers.

packages/cli:

```
index.ts
  ↓
App.ts, KeyBindings.ts, MouseHandlers.ts, NavigationController.ts,
StagingOperations.ts, ModalController.ts, FollowMode.ts
  ↓
daemon/   ui/
  ↓
state/
  ↓
utils/  types/  themes.ts  config.ts
```

The CLI is locked as a pure daemon client (severity `error`): `src/` may **not** import `@diffstalker/core/managers/*` (no in-process managers), nor `simple-git` / `chokidar` (daemon/core-only). It may still import the pure core helpers it uses (`view/*`, `git/diff`, `git/explorerData`, `git/status`/`worktree` types, `services/commitService`, `utils`, `types`).

packages/core:

```
managers/
  ↓
git/  utils/  services/  types/
```

Circular dependencies are forbidden. Run `bun run deps` to check (covers all four packages).

## Interactive Testing with tmux

Claude can run and interact with the application headlessly using tmux. This enables real integration testing without requiring a TTY.

### How Claude Tests

```bash
# Start the app in a detached tmux session
tmux new-session -d -s difftest -x 100 -y 24 'bun run dev'

# Wait for startup, then capture the screen
sleep 2 && tmux capture-pane -t difftest -p

# Capture WITH escape sequences (verify colors/SGR output)
tmux capture-pane -t difftest -e -p

# Send keystrokes (vim-style j/k work, or use Up/Down)
tmux send-keys -t difftest j          # Move down
tmux send-keys -t difftest k          # Move up
tmux send-keys -t difftest Enter      # Select/enter
tmux send-keys -t difftest '2'        # Switch to tab 2

# Clean up when done
tmux kill-session -t difftest
```

Note: `--socket PATH` now points the CLI at a `diffstalkerd` socket to attach to or spawn on (the old in-process JSON command server is gone). For scripted control against the daemon directly, `curl --unix-socket` its REST endpoints (see `packages/daemon/README.md`).

### Developer: Observe Claude's Testing

To watch Claude interact with the app in real-time, attach to the session:

```bash
tmux attach -t difftest
```

You'll see exactly what Claude sees and can watch keystrokes arrive. Detach with `Ctrl-b d`.

### Session Naming Convention

Claude uses `difftest` as the session name for testing. If you need to check for orphaned sessions:

```bash
tmux list-sessions
tmux kill-session -t difftest  # Clean up if needed
```
