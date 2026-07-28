# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Project identity now comes from git, not from path shape.** Worktrees
  were grouped by their deepest common parent directory, which assumed a
  layout: worktrees parked as SIBLINGS of the repo (`…/proj` +
  `…/proj-fix`) share only their parent, so the project was named after
  whatever directory the user happens to keep repos in. Grouping is now
  the repository's MAIN worktree (`git worktree list` reports it first,
  exposed as `isMain` on `WorktreeInfo`), which exists in every layout —
  nested under the repo, sibling, bare-with-worktrees, scattered across
  unrelated directories, or no worktrees at all. A bare main names the
  project from its directory (`…/proj/.bare` → `proj`, `…/proj.git` →
  `proj`). One test per layout.
- **The repo picker no longer forgets recent repos.** Opening or closing a
  repo — which every repo switch does — cleared the whole worktree cache,
  and recents deliberately do not render until resolved, so the Recent
  list emptied on every switch and re-resolved from scratch. Cache entries
  are now marked stale instead of dropped: the last good answer keeps
  rendering while a re-read runs in the background.
- **The repo and worktree switchers no longer disagree, and the picker no
  longer depends on when it was opened.** The header could show one
  project's name next to another repo's worktree name, and the panel's
  rows could be populated differently from one opening to the next.
  Three separate caches were answering the same question — the active
  repo's worktrees (a bare list in the daemon store, replaced only when a
  fetch happened to land), the picker's per-repo-id project map, and the
  recents' per-path map — over two endpoints, with three lifetimes and no
  sharing. They are replaced by one `worktrees` store keyed by filesystem
  path, with explicit per-entry state (pending / ready / absent /
  failed), in-flight dedup, and invalidation when the open-repo set
  changes. Every surface derives from the ACTIVE PATH, so a switch of any
  kind — picker, worktree dropdown, follow mode, URL, SSE reconnect —
  cannot leave the previous repo's data on screen, and a failed or
  out-of-order lookup can never be attributed to the wrong repo. Opening
  the worktree dropdown now re-reads its "edited N ago" / commits-ahead
  data without blanking the list while it does.

### Changed

- **Compare's diffs follow the tree order.** The file tree groups a
  directory's sub-directories before its loose files; the diff stack below
  kept the daemon's flat path sort, so the two read in different orders as
  soon as a directory held both. The stack now renders in tree order, so
  scrolling the diffs walks the tree. Collapsing a directory is a tree
  affordance only — it never reorders the diffs or drops one.
- **Diffs are no longer sent twice.** Every diff carried both its raw text
  and the parsed lines that text produces — the raw was a third of every
  diff response, and doubled what the journal retains in memory. `lines`
  is now the only representation; the raw text is derived where it is
  actually needed (hunk staging, hunk counting, per-file splitting) via
  `rawFromLines`. Combined with the size cap below, a large branch compare
  went from 53 MB to 7.2 MB. An empty diff now parses to NO lines rather
  than one phantom blank line, so the round-trip is exact.
- **Oversized file diffs are announced, not sent.** A single file's diff
  over 256 KB or 5,000 lines is no longer transferred or rendered: the
  file keeps its header, stats, and place in the list, and its body is one
  line — `Large file — diff not shown (5.7 MB, 121,235 lines)`. This is
  the same shape git already uses for binary files, so both cases now
  render through one placeholder everywhere (Changes, Compare, History,
  Journal, Explorer diffs). The cap is applied in core, so every diff the
  daemon serves gets it. On a real branch compare (841 files) this took
  the response from 53 MB to 10.6 MB, withholding six files. The two
  limits are `MAX_FILE_DIFF_BYTES` / `MAX_FILE_DIFF_LINES` in
  `core/git/diffParse`; the byte cap is the one that catches long-line
  files (minified bundles, exported SVGs) that the line cap misses.
- An untracked file too big to read now gets that same notice instead of
  an empty diff, which used to read as "no changes".

### Added

- **Version indicator in the web UI's status bar.** The far right of the
  status bar shows the running version and whether it matches what npm
  publishes: dim `v0.8.1` when it matches, `v0.8.1 → 0.9.0` in the warn
  color when a newer version is out, the accent color for a local build
  ahead of npm. New daemon endpoint `GET /version` backs it — it reads the
  running version from the daemon's own package manifest and compares it
  with npm's `latest` dist-tag, cached six hours (five minutes after a
  failed lookup) and fetched only when a client asks. The new
  `--no-update-check` flag turns the npm lookup off entirely; offline or
  opted out, the running version still shows and the comparison reads
  unknown.

## [0.8.1] - 2026-07-28

### Added

- **Web UI: recent repos group by project.** The header's "Recent" list now
  collapses a repo's worktrees into one row (like the "Open on daemon" list
  already did), instead of one row per worktree; picking a multi-worktree
  project opens its most recently edited worktree. Both lists label a
  project with the same "N worktrees" count — all of its worktrees, not
  just the open ones — so one project reads identically in either. A recent
  entry that no longer resolves to any worktree (a removed worktree
  directory still in local prefs) is dropped instead of showing as its own
  stray row.
- **Web UI: the worktree switcher is a two-line dropdown, split into
  Recent and Stale.** Replaces the native `<select>` (whose closed state
  leaked the active worktree's last-edited time into the trigger) with a
  custom panel: each row notes commits ahead of its base branch and a
  relative "edited N ago" time. A long-lived project accumulates worktrees
  without bound, so anything touched in the last week is Recent and always
  shown, while the rest collapses to three rows behind an "N more" reveal.
  The active worktree stays visible even when it falls outside that
  preview.
- **Web UI: the Changes tab shows its changed-file count** — `Changes (4)`,
  or `Changes (0)` on a clean tree — so the tab says whether there is
  anything to look at without having to open it first.
- **Web UI: wrap long lines.** A small, deliberately low-key "Wrap" toggle in
  the corner of every diff pane (Changes, Compare, History) and the Explorer
  file viewer — off by default, persisted, closer to a Notepad/Word "Word
  Wrap" checkbox than the header's headline display toggles. Unified diffs
  and the file viewer wrap; split diffs always stay on their normal
  horizontal-scroll layout (a wrapped del/add pair can wrap to a different
  line count per side, which would desync the two columns).

## [0.8.0] - 2026-07-26

A security-hardening and web-UI-polish release. The daemon is now
loopback-only with an origin guard and a least-privilege API surface, the
repo gained public-project governance, and the web UI got a round of polish.

### Security

- **The daemon binds loopback only.** Removed the `--host` flag — there is no
  option to bind a routable interface (it has no authentication). Reach it from
  another machine over an SSH tunnel (`ssh -L 7337:localhost:7337 …`).
- **Origin guard on a bound `--port`.** A `Host` allow-list blocks DNS-rebinding
  (421) and cross-site requests are rejected (CSRF, 403); non-browser clients
  (the CLI, `curl`) pass untouched. Every response also carries hardening headers
  (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`) and a
  strict `Content-Security-Policy` for the served SPA.
- **Least-privilege REST surface on a port.** A `--port` (web) daemon routes only
  what the web UI uses — reads, repo open/release, and file-level stage/unstage.
  Every CLI-only mutation (commit, discard, hunk staging, remote/branch
  operations, persisted compare base) returns `404`; the full API stays on the
  CLI's unix socket.
- Hardened the untracked-file diff (realpath containment against symlink escapes
  + a read cap) and bounded the history `count` parameter.

### Added

- Public-project governance: `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`,
  Dependabot, CodeQL, and continuous CI (build + lint + full test suite on every
  push and pull request).
- A workspace-wide circular-dependency check that catches cross-package cycles
  the per-package checks miss.

### Changed

- **Web UI polish.** Per-view toolbars now get their own row instead of crowding
  the global toggles; Compare shows the `branch → base` direction and reload
  feedback; stacked diffs pin the hunk header below the file header; the Journal
  entry header was redesigned to match the rest of the site — a `--surface`
  strip with a kind-coloured left rail, the kind shown as colour-coded text
  (the site's status idiom) and a bold filename — dropping the bordered kind
  pill and the line range that just duplicated the diff's own @@ header.
- Journal: a commit (or any boundary that retired changes) can now be folded
  to collapse the entries it committed into its one line, click to re-expand.
  And "created" now reads as "new file" only for a genuinely new file — a new
  change region in an existing file reads as "edited" (coloured modified),
  which is what it actually is.
- Journal, restraint pass: pared back to a calm second-screen viewer of your
  uncommitted work. Dropped the outdated-stub resurrection, the "seeded" tag,
  the kind-help hover glossary, per-entry copy-path, and the fold-chain
  drill-in (the ×N is now a static churn marker); `expanded`/`shrunk` fold into
  `edited` and `renamed` renders neutral, so the kind vocabulary is just
  new-file / edited / reverted; relative times freeze to a wall-clock HH:MM
  past an hour so the column stops perpetually re-ticking. Fixed selection-vs-hover across every list (a selected row was
  indistinguishable from a hovered one), added focus-visible rings, and gave the
  stage/unstage buttons semantic hover colors.
- README leads with the web UI, with light and dark screenshots.

### Internal

- Dependency refresh: eslint 10, TypeScript 6.0, chokidar 5, and the GitHub
  Actions majors. `engines.node` raised to `>=20.19.0` (chokidar 5's floor).

## [0.7.1] - 2026-07-23

### Changed

- **Compare view — the active-file indicator follows your scroll.** As you scroll
  the stacked diffs, the file list highlights whichever file you are on (and
  nearest-edge-scrolls to keep that row in view), through the SAME mechanism a
  click uses. That focus indicator is now prominent — a selection-tinted row,
  clearly distinct from the hover state — in both the Compare and Changes views,
  and the first file is selected on load so the indicator is present from the
  start.

## [0.7.0] - 2026-07-23

### Added

- **Journal view (web UI).** A new second view — a chronological, downward-only
  log of every change as it happens, tracked **per hunk** rather than per file:
  two edits to two different files land as two entries at the bottom even if
  those files also changed higher up. Each entry has a timestamp, path, kind
  (created / edited / expanded / shrunk / reverted / renamed), line span, +/−
  stats, and its own diff. When a hunk is edited/expanded/shrunk/reverted the
  older entry higher up is marked outdated and collapses while the fresh one
  appears at the bottom (lineage via a `supersedes` chain); rapid edits to one
  hunk fold into a single entry. The log is daemon-owned (HEAD-axis observation,
  in-memory, bounded/pruned), streamed over SSE with an epoch + `since`
  reconnect protocol so a client never sees a torn or interleaved log. Huge and
  binary files show a collapsed placeholder. Observation is guarded against
  torn reads during external `git checkout`/rebase so those never storm the log.
- **Diff viewing modes (web UI).** Two global, persisted header toggles applied
  to every diff surface (Changes, Journal, History, Compare) through the one
  shared diff renderer: **syntax highlighting** (highlight.js-tokenized content
  vs. plain text — language detected per file, theme-colored so it stays readable
  over the add/del row tints, composing with the existing word-level
  highlighting) and a **split / side-by-side view** (old on the left, new on the
  right; deletions paired with additions row-for-row, long lines scrolling
  horizontally).
- **File staging in the web UI.** The Changes view gains a per-row stage (+) /
  unstage (−) button — the web UI's first working-tree mutation. No commit,
  discard, or hunk-staging; those stay in the terminal UI.
- **Stacked diff surface (web UI).** Changes and Compare render every file's diff
  in one continuous scroll with sticky per-file headers and per-file collapse;
  the file list becomes a jump navigator into the stack.
- **Broader syntax-highlighting coverage.** The Explorer file viewer and the diff
  syntax mode now cover many more file types — Vue SFCs, Jenkinsfiles (Groovy),
  Dockerfiles, PowerShell, HCL/Terraform, F#, Elixir, Clojure, and others —
  instead of falling back to plain text.

### Changed

- **Responsive web layout.** The header reflows on narrow / portrait screens —
  the repo identity and the find-file + theme controls stay put while the mode
  toggles drop to their own full-width row — and at 1080px wide or less the
  activity rail becomes a top tab band and every side-by-side view (list | diff)
  stacks top-over-bottom, so nothing overflows on a vertical monitor. The app no
  longer stretches past the viewport on a wide diff line.
- **Journal polish.** Entries live-tick their relative time from the moment they
  arrive, keep the file name visible on long paths (the directory ellipses, full
  path on hover), and gain a copy-full-path button; the kind badge and the
  "changed before the Journal started" (seeded) note explain themselves on hover.
- The draggable divider between the two panes in every split view is now a
  visible bar with a grab handle, so the file list and the diff / content read as
  clearly separate. Ellipsized paths and labels throughout the UI gained hover
  titles so the full text is always reachable.

## [0.6.0] - 2026-07-21

### Added

- **Web UI (read-only viewer).** `diffstalkerd` now serves a Vue 3 browser client
  at `GET /` (run it with `--port N`, open `http://localhost:N`). It is a viewer,
  not a manager — it reads git state and never mutates it. Four views mirroring the
  terminal UI: Changes (file list + working-tree diffs, per-hunk view), History
  (commit list + diff), a GitHub-PR-style Compare view against a base branch, and
  an Explorer with syntax highlighting. Plus a fuzzy file finder, the six themes,
  and live updates over SSE. The web build ships inside the `diffstalkerd` tarball
  — it is not a separately published package. No authentication; the daemon binds
  `127.0.0.1` — keep it on localhost.
- **Follow + auto mode in the web UI.** A follow toggle switches the viewed repo
  when an external tool appends to the follow hook file. Auto mode additionally
  selects the freshest-changed file (and flashes it) and switches views as the
  changed-file set grows or empties — driven by a new per-file mtime signal the
  daemon now includes in shared state (browsers can't `fs.stat`, and it also
  defeats SSE payload dedup so in-place edits still fire an update).
- **Portrait / vertical-monitor layout.** On portrait or square viewports the
  view rail rotates into a full-width top tab band and each view stacks its list
  above a full-width diff, with drag-resizable rows. Landscape is byte-for-byte
  unchanged.
- **Collapsible folders** in the web Compare and Explorer file trees, with
  single-child directory chains folded onto one row for compactness.
- A favicon (the diff-gutter add/remove mark) for the web UI.

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
