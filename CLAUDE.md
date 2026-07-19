# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository. Last reviewed: 2026-07.

## Project Overview

diffstalker is a terminal UI for interactive git staging and committing, built with TypeScript and neo-blessed. It follows a push-based architecture where external tools write repository paths to a watched file (follow mode).

## Feature Documentation

**IMPORTANT:** After adding a new feature, update `FEATURES.md` to document it. Keep the feature list organized by category (Views, Navigation, Operations, etc.).

## Tech Stack

- **TypeScript** with ESM modules, compiled with `tsc`, run with **bun** in development
- **neo-blessed** for terminal rendering (patched at runtime for 24-bit RGB, see `src/utils/blessedRgbPatch.ts`)
- **chokidar** for file watching (follow hook file, git dir, working tree)
- **simple-git** for git operations
- **fast-diff** for word-level diff highlighting
- **emphasize** for syntax highlighting in the explorer
- **fzf** for file finder matching
- Event-driven state management with Node `EventEmitter` (no React)

## Build Commands

The app lives in the `packages/cli` workspace; root scripts delegate there, so these all work from the repo root:

```bash
bun run dev           # Run with bun --watch (development)
bun run build         # Clean dist/ and compile TypeScript
bun run build:prod    # Build + minify dist/index.js (what npm consumers get)
bun run start         # Run compiled version
bun run test          # Run the test suite (or: cd packages/cli && bun test src/*.test.ts src/**/*.test.ts)
bun run lint          # ESLint + dependency-cruiser
bun run deps          # Dependency-cruiser only
bun run metrics       # Code quality metrics report (scripts/collect-metrics.ts)
```

## Releasing

Use `bun run release` to publish a new version. This bumps `package.json`, commits, tags, and pushes. The script refuses to run if the working tree is dirty or if `CHANGELOG.md` has no entry for the new version. The pre-push hook runs the full test suite before the tag push is allowed through. CI then builds, tests, publishes to npm, and commits a metrics snapshot.

```bash
bun run release         # patch bump (0.3.0 -> 0.3.1)
bun run release:minor   # minor bump (0.3.1 -> 0.4.0)
bun run release:major   # major bump (0.4.0 -> 1.0.0)
```

Never bump `package.json` or create version tags manually — always use the script so the version, changelog, and tag stay in sync.

## Project Structure

The repo is a bun workspace with two packages: `@diffstalker/core` (headless git state, no UI deps) and `diffstalker` (the terminal UI, published to npm). The cli imports core via subpath imports only (e.g. `@diffstalker/core/git/status`) — there is no barrel/bare specifier.

```
packages/core/src/
├── git/                    # Plain async functions wrapping simple-git / git CLI
│   ├── status.ts           # getStatus, stage/unstage, hunk staging, commits
│   ├── diff.ts             # Diff generation and parsing, hunk extraction
│   ├── hunkTimes.ts        # Per-hunk edit timestamps
│   ├── worktree.ts         # Worktree/bare-repo resolution and listing
│   └── ignoreUtils.ts      # Gitignore checking
├── managers/               # EventEmitter-based state managers
│   ├── GitStateManager.ts  # Thin coordinator: workingTree/history/compare/remote per repo
│   ├── WorkingTreeManager.ts # Status+diff state, git/working-dir watchers ('state-change')
│   ├── HistoryManager.ts   # Commit history ('history-state-change')
│   ├── CompareManager.ts   # Base-branch comparison ('compare-state-change')
│   ├── RemoteOperationManager.ts # push/fetch/pull/stash/branch ops ('remote-state-change')
│   ├── GitOperationQueue.ts # Serializes git operations per repo, refresh scheduling
│   ├── FilePathWatcher.ts  # Watches the follow hook file
│   └── ExplorerStateManager.ts # Explorer tree state
├── services/
│   └── commitService.ts    # Git commit execution
├── utils/                  # logger, path utils, base-branch cache
└── types/                  # Shared type declarations (remote)

packages/cli/src/
├── index.ts                # Entry point: CLI args, terminal cleanup, crash handlers
├── App.ts                  # Main controller: screen, managers, listeners, render loop
├── KeyBindings.ts          # All keyboard bindings (screen-level), KeyBindingActions interface
├── MouseHandlers.ts        # Mouse event handling against layout regions
├── NavigationController.ts # Selection movement, scrolling, hunk navigation
├── StagingOperations.ts    # Stage/unstage/toggle operations, pending selection intents
├── ModalController.ts      # Single source of truth for modal state (ModalType union)
├── FollowMode.ts           # Follow hook file -> repo switching
├── config.ts               # Config loading/saving (~/.config/diffstalker/config.json)
├── themes.ts               # Theme definitions (6 themes)
├── ui/
│   ├── Layout.ts           # LayoutManager: blessed boxes, split ratio, pane sizing
│   ├── PaneRenderers.ts    # renderTopPane/renderBottomPane dispatch per tab
│   ├── widgets/            # Pure formatters returning strings for blessed boxes
│   │   ├── Header.ts, Footer.ts, FileList.ts, FlatFileList.ts
│   │   ├── DiffView.ts, HistoryView.ts, CompareListView.ts
│   │   ├── CommitPanel.ts, ExplorerView.ts, ExplorerContent.ts
│   └── modals/             # Modal implementations (Modal interface: destroy/focus)
│       ├── Modal.ts, ThemePicker.ts, HotkeysModal.ts, RepoPicker.ts
│       ├── WorktreePicker.ts, BaseBranchPicker.ts, DiscardConfirm.ts
│       ├── FileFinder.ts, CommitActionConfirm.ts
├── state/
│   ├── UIState.ts          # Panes, tabs, focus zones, selection indices, toggles
│   ├── CommitFlowState.ts  # Commit panel state machine
│   └── FocusRing.ts        # Tab/Shift-Tab focus zone cycling
├── ipc/
│   └── CommandServer.ts    # Unix socket JSON command server (--socket, used for testing)
├── utils/                  # Pure helpers (displayRows, layout math, ansi, paths...)
└── types/                  # Shared type declarations (tabs, neo-blessed shim)
```

## Key Patterns

### State Managers and Events

All app state lives in EventEmitter-based managers; blessed widgets are dumb renderers. `App.ts` subscribes to manager events (`state-change`, `history-state-change`, `compare-state-change`, `remote-state-change`) and calls `render()`, which re-renders panes via `PaneRenderers`. Managers are registered per repo path (`getManagerForRepo`); switching repos disposes the old manager's listeners.

Errors are surfaced by setting `error` in `WorkingTreeManager` state (`setError()`), which the header renders and the next refresh clears. Never emit unsubscribed `'error'` events — an EventEmitter `'error'` without a listener crashes the process.

### Git Operations

Plain functions in `src/git/` wrap simple-git. Mutations go through `GitOperationQueue` (one queue per repo) so operations serialize and refreshes coalesce. UI-triggered operations live on the managers (e.g. `WorkingTreeManager.stageFile`) which update state and surface errors instead of crashing. `getStatus` returns `isRepo: false` only for a genuine non-repo; other failures propagate to keep the previous status visible.

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
2. Add a method on the owning manager in `packages/core/src/managers/` that runs it through the queue and updates state with error handling
3. Wire it from `App.ts` (action) and `KeyBindings.ts` (key)

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
- `simple-git` status may include gitignored files in some cases; we filter with `git check-ignore`
- neo-blessed truecolor only works because of the runtime patch (`applyBlessedRgbPatch()` runs before screen creation); content SGR `38;2;R;G;B` codes are otherwise downsampled
- Tests must not create real chokidar watchers: construct `WorkingTreeManager` without calling `startWatching()`

## Code Quality Guidelines

### Pre-commit Hook

A pre-commit hook runs `bun run lint` (ESLint + dependency-cruiser) before every commit. It lives in `.githooks/pre-commit` and is activated via the `prepare` script after `bun install`. 19 pre-existing sonarjs cognitive-complexity warnings are expected (6 in packages/core + 13 in packages/cli), 0 errors.

### Architecture Layering (dependency-cruiser)

Each package has a `.dependency-cruiser.cjs` enforcing that lower layers do not import higher layers.

packages/cli:

```
index.ts
  ↓
App.ts, KeyBindings.ts, MouseHandlers.ts, NavigationController.ts,
StagingOperations.ts, ModalController.ts, FollowMode.ts
  ↓
ui/
  ↓
state/    ipc/
  ↓
utils/  types/  themes.ts  config.ts
```

packages/core:

```
managers/
  ↓
git/  utils/  services/  types/
```

Circular dependencies are forbidden. Run `bun run deps` to check (covers both packages).

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

There is also a Unix socket command server for scripted control: start with `--socket /tmp/ds.sock` and send newline-delimited JSON commands (see `src/ipc/CommandServer.ts`).

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
