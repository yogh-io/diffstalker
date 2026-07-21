# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Web UI.** `diffstalkerd` now serves a Vue 3 browser client at `GET /` (run it
  with `--port N`, open `http://localhost:N`) at feature parity with the terminal
  UI: a Changes source-control panel (file + per-hunk staging, discard, commit /
  amend), History (commit diff, cherry-pick / revert), a GitHub-PR-style Compare
  view, an Explorer with syntax highlighting, remote/branch operations (fetch /
  pull / push, branch switch/create, stash, soft reset, abort/continue), a fuzzy
  file finder, follow mode, the six themes, and live updates over SSE. The web
  build ships inside the `diffstalkerd` tarball — it is not a separately published
  package. No authentication yet; the daemon binds `127.0.0.1` — keep it on
  localhost.

### Internal

- **Single-source versioning.** The root `package.json` is now the one source of
  version truth. `scripts/release.sh` reads and bumps it, and derives the two
  published manifests (`diffstalker`, `diffstalkerd`) from it in lockstep. The
  private, bundled packages (`@diffstalker/core`, `@diffstalker/client`,
  `@diffstalker/web`) are pinned to a static `0.0.0` and never versioned — they
  ship inside the published bundles, never on their own. The release's bun.lock
  patch is now equality-scoped to the outgoing version and asserts the published
  entries landed on the new one, so it can't silently ship a stale pin.
- A shared `@diffstalker/core/view/*` presentation-logic layer (diff/word/tree/
  format helpers) extracted from the CLI and reused by the web client.

## [0.5.1] - 2026-07-20

### Fixed

- The published `diffstalker` now pins the exact matching `diffstalkerd`
  version. `release.sh` refreshes `bun.lock`'s workspace versions on bump
  (`bun pm pack` derives the cli's `diffstalkerd` pin from the lockfile, not
  the manifest), and CI now fails the release if any published package's
  workspace-sibling pin is not the exact release version. 0.5.0 shipped
  pinning `diffstalkerd@0.4.0` — functional (same daemon build) but wrong.

## [0.5.0] - 2026-07-20

### Changed

- **Daemon architecture.** The single npm package was split into a bun
  monorepo of four packages: `@diffstalker/core` (headless git state),
  `@diffstalker/daemon` (`diffstalkerd`: a Node http REST + SSE server over
  core), `@diffstalker/client` (a typed REST + SSE client), and `diffstalker`
  (the terminal UI). Same features, new plumbing.
- **The CLI is now a daemon-backed client.** It holds no in-process git: on
  launch it attaches to a running `diffstalkerd` or spawns one on a unix
  socket, opens repos over REST, and follows live state over SSE. A new
  `RepoSession` is the client-side store (shared state over SSE + mutation
  envelopes; selection/history/compare pulled on demand).
- **The daemon owns git state and follow mode.** It watches the follow hook
  file and broadcasts `follow-change` so any client can switch focus; the CLI
  reacts to it as policy. The in-process command server and follow-file
  watcher were removed from the CLI.
- Opening or following a bare-repo container no longer forces a worktree
  choice through the picker; the most recently active worktree (by git
  index/HEAD activity) is opened automatically. Shift+W still switches
  worktrees explicitly.
- **A leaner `diffstalker`.** The published UI no longer depends on a git
  library: the pure diff/patch parsers it needs (hunk extraction, status
  maps) were split into dependency-free core modules, so `simple-git` is now
  a `diffstalkerd`-only dependency. The two published packages are the lean
  `diffstalker` (which pulls in `diffstalkerd`) and `diffstalkerd` itself.

### Added

- **`diffstalkerd` binary** (`@diffstalker/daemon`): REST + SSE over
  `@diffstalker/core`, unix-socket by default (`0600` under
  `$XDG_RUNTIME_DIR`), with follow mode and systemd socket activation. See
  `packages/daemon/README.md`.
- **Graceful daemon reconnect.** When the SSE stream drops, the CLI shows one
  calm "daemon connection lost — reconnecting…" line and recovers in the
  background — re-spawning the daemon if needed and re-opening repos by their
  stable path-hashed id (no ENOENT screen spam).
- `scripts/rmrf.sh` helper for safe recursive deletes.

### Removed

- The `--once` flag (show status once and exit). The UI is always a live,
  daemon-backed view now.
- The in-process command server and follow-file watcher, which moved into
  `diffstalkerd`.

## [0.4.0] - 2026-07-07

### Fixed

- **npm package was uninstallable**: the postinstall hook pointed at a script
  excluded from the published tarball, so every `npm install diffstalker`
  failed. The neo-blessed 24-bit RGB patch is now applied at runtime, with no
  postinstall step.
- Commit submission: pressing Enter in the commit input never actually
  submitted (it appended an invisible newline); the commit is now submitted
  with Ctrl+S.
- Transient git failures (e.g. index.lock contention) no longer wipe the file
  list by masquerading as "not a git repository".
- Watcher and IPC socket errors no longer crash the app; errors surface in
  the header instead of disappearing.
- Crash diagnostics are printed to the normal screen buffer instead of being
  discarded with the alternate one.
- Untracked file names containing shell metacharacters no longer break the
  diff preview.

### Added

- Per-hunk edit times in the diff viewer ("just now", "5 minutes ago",
  "2 days ago"), observed live while diffstalker runs, with file mtime as
  the fallback for pre-session changes. Freshly-changed hunks flash yellow,
  and in auto mode the diff pane scrolls to keep the newest change on
  screen. Sub-minute times update every second.
- Multi-line commit messages: the commit input is now 4 rows; Enter inserts
  a newline, Ctrl+S commits.
- Page scrolling (PageUp/PageDown, Ctrl+U/Ctrl+D) and jump to top/bottom
  (g/G) in lists and diff panes.
- `d` on an untracked file now offers to delete it (git clean) with
  confirmation.
- Tests for the hunk staging pipeline and WorkingTreeManager.

### Changed

- Published package ships via a files allowlist; requires node >= 20.
- Releases publish to npm before pushing the metrics commit, and refuse to
  run without a changelog entry.

## [0.3.0] - 2026-07-06

### Added

- Git worktree and bare-repo layout support, with a worktree switcher
- Mouse support in the repo picker
- "Include uncommitted" checkbox rendered in the Compare view
- Auto-scroll to the latest changed file in auto mode

### Fixed

- Follow mode not switching into a nested repository

## [0.2.6] - 2026-03-08

### Fixed

- Error spam when opening a non-git directory

## [0.2.5] - 2026-03-06

### Added

- Show application version in hotkeys modal footer

## [0.2.4] - 2026-03-08

### Added

- Repo picker modal (`r`) for switching between recent repositories
- Focus zone system for Tab/Shift-Tab navigation

### Changed

- Commit tab stripped to the essentials: message input, amend, submit
- Modal state centralized in ModalController

### Fixed

- `q` closing the app while a modal was open
- Hotkeys modal `?` toggle race condition
- History selection not updating after refresh

## [0.2.3] - 2026-02-06

### Added

- Repository control center on the commit tab
- Release script and documented release workflow

### Changed

- File finder rebuilt on `git ls-files` with fzf matching

## [0.2.2] - 2026-02-01

### Added

- Hunk-level staging with toggle key, click selection, and per-file indicators
- Flat file view with combined interleaved diff
- fzf-powered file finder (Ctrl+P)
- Unit and integration tests for git and utility modules
- dependency-cruiser architecture layering rules
- Pre-push hook running tests before tag pushes

### Fixed

- Phantom context line on the last hunk of a diff
- Selection desync on full-hunk staging
- Explorer mouse and keyboard bugs

## [0.2.1] - 2026-01-30

### Added

- Explorer tree view with git status, file finder, and selection anchor
- Code quality metrics tooling

### Changed

- App.ts decomposed into KeyBindings, MouseHandlers, PaneRenderers, and FollowMode modules

### Fixed

- Watcher cleanup and state refresh when switching repositories

## [0.2.0] - 2026-01-27

### Changed

- **Major rewrite**: Migrated from Ink (React for CLIs) to neo-blessed for native terminal rendering
- Significantly improved scroll performance - no more lag on large diffs
- More responsive UI with direct terminal control
- Reduced memory footprint
- Gitignore-aware file watching - no longer watches inside node_modules, dist, etc.

### Added

- Base branch picker modal (`b` in Compare view) for selecting PR comparison base
- Discard confirmation dialog (`d` on unstaged files) with y/n prompt
- Toggle uncommitted changes in Compare view (`u`)
- External git operation detection - UI updates when staging/committing outside the app
- Explorer view (tab 5) for browsing repository files with syntax highlighting
- tmux-test.sh script for headless UI testing

### Fixed

- Window resize now properly updates all UI elements
- Diff content no longer contains control characters
- Improved diff line alignment and file separation
- Modal key isolation - navigation keys no longer affect background list when modal is open
- Auto-scroll keeps selection visible when navigating in all list views
- Commit textarea focus no longer crashes the app
- Terminal cleanup on startup clears leftover mouse mode from previous crashes

### Technical

- Replaced React hooks with event-driven state management
- Single source of truth pattern for scroll calculations
- Operation queue for serialized git operations
- Polling-based git watcher for reliable atomic write detection

## [0.1.0] - 2026-01-21

### Added

- Initial release
- Four views: Diff, Commit, History, and PR comparison
- Two-pane layout with resizable split
- Mouse support: click to select, stage/unstage, scroll, switch tabs
- Word-level diff highlighting
- 6 color themes including colorblind-friendly and ANSI-only variants
- Follow mode for shell integration
- Keyboard navigation with vim-style bindings
