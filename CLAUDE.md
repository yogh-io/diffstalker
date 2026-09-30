# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository. Last reviewed: 2026-09.

## Project Overview

diffstalker is a tool for watching and staging git changes, built with TypeScript. It has two clients: a web UI (Vue) and a terminal UI (neo-blessed).

The git state engine lives in a **daemon** (`diffstalkerd`): a Node http server exposing `@diffstalker/core` over REST + Server-Sent Events. Both UIs are **clients** of that daemon — neither holds in-process git. On launch the CLI attaches to a running daemon or spawns one on a unix socket, opens repos over REST, and follows live state over SSE. The daemon owns follow mode: it watches ONE hook file external tools append repo/file paths to, and broadcasts `follow-change` so clients can switch focus. It also owns the persistent settings (`~/.config/diffstalker/daemon.json`) and the **watch directories** in them: folders it scans for git repos so clients can offer "your projects" instead of an empty path field. It keeps an append-only edit **journal** per repo, and, with the opt-in grammars package installed, computes in-file symbol **outlines** in a worker thread. The web UI is served by the daemon itself at `GET /`.

**The web UI is the client that gets new work.** The CLI (`packages/cli`) is kept and must keep building and passing lint, but it is demoted: nobody is testing it day to day, and a feature request that does not name a client targets the web UI. Do not build CLI-side UI (new modals, new panes) unless asked.

## Feature Documentation

**IMPORTANT:** After adding a new feature, update `docs/FEATURES.md` to document it. Keep the feature list organized by category (Views, Navigation, Operations, etc.).

**Before starting a feature, read `docs/feature-review-0.9.0.md`.** The project is
deliberately not growing features right now. That doc records what was already
considered and rejected (and why), what is known broken and deferred, and the
specific things that would justify revisiting. It exists so the same ground is not
re-covered from scratch.

## Tech Stack

- **TypeScript** with ESM modules, compiled with `tsc`, run with **bun** in development
  - On **TS 6.0** (the deprecation-bridge before the native 7.0). We can't go to
    7.0 yet: 7.0 shipped with no programmatic compiler API, so the tools that embed
    it — `typescript-eslint` (lint) and Volar/`vue-tsc` (web type-check) — are hard-
    blocked until TS **7.1**. The 6.0 migration already cleared the 5→7 gotchas
    (`types: ["node"]` in `tsconfig.base.json`; `rootDir` set explicitly), so when
    7.1 lands it's a one-line bump for the whole repo. Do NOT split-toolchain a
    7.0-tsc-for-CLI hack — the build is sub-2s, so the gain is nil.
- **bun 1.4.2**, pinned in the root `package.json` (`packageManager`) and in CI
  (`bun-version: 1.4.2` in both workflows). 1.4.2 is the floor, not a preference:
  bun 1.3's `fs.watch` opened every entry of a watched directory, so one FIFO in a
  working tree blocked a pool thread under the watcher mutex and froze the whole
  daemon, `/health` included. Bun 1.4 opens with `O_PATH`, which never blocks, so
  the FIFO guard the code carried (`utils/watchGuards.ts`) is gone.
  `WorkingTreeManager.watch.test.ts` pins this (see Gotchas). Node `>=20.19` at runtime.
- **Node `http`** for the daemon (REST + SSE over `@diffstalker/core`, no framework)
- **simple-git** for git operations — **core/daemon only** (no client runs git in-process). `git grep` and blob reads spawn git directly (`execFile` with a byte budget) because simple-git decodes stdout as UTF-8.
- **chokidar** for file watching (follow hook file, git dir, working tree, watch-directory roots) — **core/daemon only**
- **web-tree-sitter** for symbol outlines — loaded only inside the daemon's symbol worker thread; the grammars come from the opt-in `diffstalkerd-grammars` package
- **Vue 3 + Pinia + Vite** for the web UI (`vitest` for its tests), **highlight.js** for its syntax highlighting
- **neo-blessed** for terminal rendering (CLI; patched at runtime for 24-bit RGB, see `packages/cli/src/utils/blessedRgbPatch.ts`)
- **fast-diff** for word-level diff highlighting (in `@diffstalker/core/view/wordDiff`, bundled into CLI + web)
- **emphasize** for syntax highlighting in the CLI explorer
- **fzf** for file finder matching (matching logic shared in `@diffstalker/core/view/finderModel`)
- Event-driven state: Node `EventEmitter` inside the daemon (managers) and inside the CLI's `RepoSession`; Pinia stores in the web (no React)

## Build Commands

The repo has six packages (`packages/core`, `packages/daemon`, `packages/client`, `packages/cli`, `packages/web`, `packages/grammars`). Root scripts delegate to the five code packages (grammars is data: it has only `vendor` / `verify`), so these all work from the repo root (`dev`/`start` target the cli):

```bash
bun run dev           # Run the CLI with bun --watch (development)
bun run dev:web       # Vite dev server for the web UI alone
bun run serve         # Dev stack: web UI with HMR on :17337, proxying a source daemon on :17338
bun run build         # Clean dist/ and compile TypeScript (all packages, plus the web bundle into the daemon)
bun run build:prod    # Build + minify the CLI's dist/index.js (what npm consumers get)
bun run start         # Run the compiled CLI
bun run test          # Run the full suite across all packages
bun run lint          # ESLint + dependency-cruiser (all packages, then the workspace cruise)
bun run deps          # Dependency-cruiser only (all packages, then the workspace cruise)
bun run metrics       # Code quality metrics report (scripts/collect-metrics.ts, all packages)
```

`bun run serve` (`scripts/serve.ts`) is the dev counterpart of the released daemon a systemd unit runs on `:7337`; the two run side by side and never share a port.

### Running

`diffstalker` (the CLI) auto-spawns the daemon: on launch it looks for a live `diffstalkerd` on the socket (`--socket PATH`, then `$DIFFSTALKER_SOCKET`, then `--instance NAME` / `$DIFFSTALKER_INSTANCE` naming `<NAME>.sock`, then `$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock`), attaches if one answers, and otherwise spawns one that outlives the TUI. The CLI never stops the daemon; on exit it just releases its repos (`DELETE /repos/:id`, refcounted). `diffstalker link [view] [path]` is a subcommand that prints a web-UI URL for a place in a repo, after asking the daemon that the repo, file and anchor exist (`packages/cli/src/commands/link.ts`; the URL grammar is `@diffstalker/core/view/urlGrammar`, shared with the web).

To run the daemon standalone (for a non-TUI client, or to keep it warm):

```bash
bun packages/daemon/src/index.ts            # development (source)
node packages/daemon/dist/index.js          # after bun run build
diffstalkerd --socket /path/to.sock         # explicit socket
```

The daemon resolves its socket as: `--socket PATH`, then a systemd socket-activation fd (`LISTEN_FDS`), then `$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock` (dir `0700`, socket `0600`). It refuses to start if `XDG_RUNTIME_DIR` is unset and nothing else is given — there is no `/tmp` fallback. Other flags: `--instance NAME` (binds `<NAME>.sock` so several daemons can coexist), `--port N` (loopback TCP, for browsers), `--no-socket` (needs `--port`), `--follow-file PATH` / `--no-follow`, `--web-root DIR`, `--grammars DIR`, `--no-update-check`, `--debug`.

Each listener gets its own routing table (`ApiMode` in `server.ts`): the unix socket (or inherited fd) is owner-only and carries the **full** API; a TCP port is reachable by any local process and carries the **web** subset — reads, repo open/release, file-level stage/unstage, settings. Commit, discard, hunk staging and all remote/branch ops are not routed there at all (they 404). `security.ts` adds the browser-side guards for the port: a loopback `Host` allow-list (DNS rebinding), a `Sec-Fetch-Site` / `Origin` check on non-GET requests (CSRF), and `Sec-Fetch-Dest: image` plus `Cross-Origin-Resource-Policy: same-origin` on `/blob`. See `packages/daemon/README.md` for the full endpoint table, the journal, image-bytes, watch-directory and follow-mode notes.

## Releasing

Use `bun run release` to publish a new version. The **root `package.json` is the single source of version truth**: the script reads and bumps it, and derives the three published manifests (`diffstalker`, `diffstalkerd`, `diffstalkerd-grammars`) from it in lockstep (they must carry a literal version for npm). The three private, bundled packages (`@diffstalker/core`, `@diffstalker/client`, `@diffstalker/web`) stay at a static `0.0.0` and are never versioned — they ship inside the published bundles, not on their own. The script commits, tags, and pushes; it refuses to run if the working tree is dirty or if `CHANGELOG.md` has no entry for the new version. The pre-push hook (`scripts/githooks/pre-push`) dry-runs the release workflow with `act` when a tag is pushed (and skips with a note when `act` is not installed); ordinary pushes are not gated. CI then builds, tests, publishes to npm, and commits a metrics snapshot.

```bash
bun run release         # patch bump (0.3.0 -> 0.3.1)
bun run release:minor   # minor bump (0.3.1 -> 0.4.0)
bun run release:major   # major bump (0.4.0 -> 1.0.0)
```

Never bump `package.json` or create version tags manually — always use the script so the version, changelog, and tag stay in sync.

## Project Structure

The repo is a bun workspace with six packages:

- **`@diffstalker/core`** — headless git state (plain git fns + a small set of managers), the pure symbol model, and the browser-safe `view/` presentation logic; no UI deps. The daemon consumes its managers; the CLI and web client import pure helpers/types from it (`view/*`, `git/diffParse`, `git/explorerStatus`, `git/status`/`worktree`/`diff` types, `services/commitService`, `symbols/{types,languages,mapping,vueBlocks}`, `utils`, `types`) but **not** its managers and never `symbols/extract`.
- **`@diffstalker/daemon`** — diffstalkerd, published to npm as a bin-only package (an executable, not an importable API): Node http REST + SSE over core. Owns git state, follow mode, the persistent settings + repo discovery they drive, the journal stores, the symbol worker, and the version/update check; serves the web UI at `GET /`.
- **`@diffstalker/client`** — a typed REST + SSE client for the daemon (node transport: unix socket or TCP). Private; consumed by the CLI, including `diffstalker link`. The web UI has its own browser `fetch` client in `packages/web/src/api/` that reuses this package's wire types **type-only**.
- **`diffstalker`** (`packages/cli`) — the terminal UI, published to npm. A pure daemon client: `RepoSession` fed by REST + SSE, `DaemonLifecycle` to attach/spawn. Demoted, see Project Overview.
- **`diffstalkerd-grammars`** (`packages/grammars`) — tree-sitter grammars, the
  runtime wasm, and our outline `.scm` queries. Pure data, no code, no install
  scripts. **Opt-in and NOT a dependency of anything**: a default `diffstalkerd`
  install does not carry it and simply has no outlines, which `GET /health`
  reports. The `.wasm` files are not committed — `bun run vendor` fetches them
  against pinned versions and checksums, and writes nothing on a mismatch,
  because a grammar that drifts from its query produces confidently wrong labels
  rather than an error. Run `cd packages/grammars && bun run vendor` once after
  cloning if you want outlines locally; the symbol tests skip without it.
- **`@diffstalker/web`** — the browser UI (Vue 3 + Vite + Pinia): a pure daemon client over the same REST + SSE. Private; its built assets are bundled INTO the `diffstalkerd` tarball and served same-origin (not a separately published package). Shipped in v0.6.0.

The three **published** packages are `diffstalker`, `diffstalkerd` and `diffstalkerd-grammars`; the other three are private and bundled. Grammars are published but **opt-in** — nothing depends on them, and a daemon without them simply reports no outline capability. See Releasing for the single-source version model.

Everything imports core via subpath imports only (e.g. `@diffstalker/core/git/status`) — there is no barrel/bare specifier. Dependency-cruiser rules forbid the CLI and the web from importing `@diffstalker/core/managers/*`, `@diffstalker/core/symbols/extract`, `web-tree-sitter`, `simple-git`, or `chokidar` (see Architecture Layering).

```
packages/core/src/
├── git/                    # Plain async functions wrapping simple-git / git CLI
│   ├── gitClient.ts        # Shared simple-git instance factory
│   ├── status.ts           # getStatus, stage/unstage, hunk staging, commits, remote/branch/stash ops
│   ├── diff.ts             # Diff generation (git exec); re-exports diffParse + hunk extraction
│   ├── diffParse.ts        # Pure diff/patch parsing + extractHunkPatch — no simple-git, browser-safe
│   ├── diffAttributes.ts   # Turns on git's built-in funcname drivers via core.attributesFile
│   ├── blob.ts             # openBlob: raw bytes at worktree/index/head, size+mode checked first
│   ├── grep.ts             # Repo-wide content search over `git grep -F` (fixed strings only, byte budget)
│   ├── explorerData.ts     # Tree listing + file reads for the explorer (git check-ignore, fd reads)
│   ├── explorerStatus.ts   # Pure buildGitStatusMap — split out so the CLI can import it without simple-git
│   ├── hunkTimes.ts        # Per-hunk edit timestamps
│   ├── discoverRepos.ts    # Watch-directory scan: git repos under a dir (fs only, no git)
│   ├── worktree.ts         # Worktree/bare-repo resolution and listing
│   └── ignoreUtils.ts      # Gitignore checking
├── managers/               # EventEmitter-based state managers (daemon-side only)
│   ├── GitStateManager.ts  # Thin coordinator: workingTree + remote + journal per repo
│   ├── WorkingTreeManager.ts # Status+diff state, git/working-dir watchers ('state-change', 'journal-observation')
│   ├── RemoteOperationManager.ts # push/fetch/pull/stash/branch ops ('remote-state-change')
│   ├── JournalManager.ts   # Append-only hunk-granular edit journal from observations ('append')
│   ├── GitOperationQueue.ts # Serializes git operations per repo, refresh scheduling
│   └── FilePathWatcher.ts  # Watches the follow hook file
├── services/
│   └── commitService.ts    # Commit message validation/formatting
├── symbols/                # In-file symbol outlines (tree-sitter)
│   ├── types.ts            # The symbol model + outcome types (browser-safe, types only)
│   ├── languages.ts        # Which grammar answers for a path (closed set; not view/languageDetection)
│   ├── mapping.ts          # symbolAt / markChangedSymbols — null rather than a guess
│   ├── vueBlocks.ts        # Finds every <script> block in a .vue file (included ranges, file-absolute lines)
│   └── extract.ts          # The tree-sitter engine — runs ONLY inside the daemon's worker thread
├── view/                   # Pure presentation logic, shared by CLI + web (no UI/node/ANSI deps)
│   ├── wordDiff.ts         # Word-level diff segments (fast-diff)
│   ├── diffPrimitives.ts   # Hunk header parsing, change-run pairing, line-number widths
│   ├── diffRowCalculations.ts # getLineContent and friends
│   ├── diffFilters.ts      # Which diff headers/lines are displayable
│   ├── splitDiffByFile.ts  # Whole-tree DiffResult -> per-file DiffResults (also used by JournalManager)
│   ├── lineBreaking.ts     # Manual line wrapping at exact widths
│   ├── fileTree.ts, flatFileList.ts, fileCategories.ts # File-list row models
│   ├── finderModel.ts      # The one copy of the fuzzy-finder matching/selection logic
│   ├── outlineModel.ts     # What the outline panel says in each of its states
│   ├── urlGrammar.ts       # The web UI's URL grammar (read by useUrlSync, written by `diffstalker link`)
│   ├── themes.ts           # The six theme names + diff palette, shared by CLI and web
│   ├── formatPath.ts, formatDate.ts, commitFormat.ts # Pure formatters
│   └── languageDetection.ts # getLanguageFromPath (highlight.js names; NO emphasize/ANSI — that stays in cli)
├── utils/
│   ├── logger.ts           # The stderr logger (see Errors and logging)
│   ├── xdg.ts              # XDG config/cache/state/runtime dirs (runtimeDir() is null when unset)
│   ├── pathUtils.ts        # Tilde expansion, ensureTargetDir
│   ├── baseBranchCache.ts  # Persisted compare base per repo
│   ├── fdRead.ts           # Open-then-read-from-the-same-fd, shared by blob and explorer reads
│   ├── imageSniff.ts       # Pure magic-byte image validation (PNG/JPEG/GIF only) + the caps
│   ├── binaryDetect.ts     # isBinaryContent: the NUL scan, shared by diff.ts and explorerData.ts
│   └── blobRef.ts          # blobUrl/mediaUrl — the one copy of the byte-endpoint URL shape
└── types/                  # Shared type declarations: remote.ts (RemoteOperation), journal.ts (JournalEntry, JournalStore)
```

`view/` holds framework-agnostic presentation logic extracted from the CLI so the CLI and the web client
share one copy. It imports git/, utils/ and symbols/ **types only** (a runtime import would drag node-only code
into a browser bundle — a dependency-cruiser rule enforces this); the one runtime exception is `git/diffParse`,
which is dependency-free by design. Its ANSI counterpart (emphasize highlighting) stays in
`packages/cli/src/utils/syntaxHighlight.ts`; the row builders that bake ANSI in (`displayRows`,
`explorerDisplayRows`) also stay in the CLI.

History, compare, explorer and search have **no** managers: the daemon serves them on demand with plain git fns (`git/status`, `git/diff`, `git/explorerData`, `git/grep`) and holds no per-client selection or tree expansion.

```
packages/daemon/src/
├── index.ts                # Entry point: parseArgs, socket resolution (flag, LISTEN_FDS, XDG), signals
├── server.ts               # createDaemon: http server, one router per listener (ApiMode full/web), listen/close
├── router.ts               # Method+path router, JSON bodies, HttpError -> {error}, sendBytes, failure logging
├── security.ts             # Loopback Host allow-list, CSRF check on non-GET, image-subresource guard
├── staticFiles.ts          # Serves the bundled web UI (SPA fallback); its CONTENT_TYPES are for the SPA only
├── repoRegistry.ts         # Open repos by path, stable ids, refcounting, follow-ref, journal-store LRU cache
├── follow.ts               # Hook-file watcher -> resolve path -> open repo -> broadcast
├── settings.ts             # Persistent daemon settings (~/.config/diffstalker/daemon.json)
├── discovery.ts            # Watch directories: scan + watch, 'discovery-change' broadcasts
├── sse.ts                  # Per-repo + daemon-scope SSE hubs fanning out events
├── serialize.ts            # Wire encoders (shared state, Dates/Maps to JSON)
├── blobSemaphore.ts        # Bounded concurrency for the byte routes (/blob, /media)
├── install.ts              # How this daemon was installed (npm/bun/pnpm/yarn/pacman) and the update command
├── version.ts              # Running version vs npm's latest (cached lookup), for GET /version
├── symbols/
│   ├── resolveArtifacts.ts # Finds the grammars (--grammars, the opt-in package) and verifies checksums
│   ├── pool.ts             # Owns the symbol worker: wall-clock deadline, respawn after a poisoned parse
│   └── symbolWorker.ts     # The worker thread the engine runs in (no try/catch around it on purpose)
└── routes/                 # One module per endpoint group
    ├── shared.ts           # RouteDeps, requireRepo/requireRepoHandle, field/param validation, git -> HTTP status
    ├── health.ts           # GET /health (ok, ready, home, http port, symbol capability)
    ├── version.ts          # GET /version
    ├── repos.ts            # /repos list/open/close, /repos/:id/worktrees, /worktrees, /resolve
    ├── workingTree.ts      # /status, /diff, /stage, /unstage, /repos/:id/events (SSE)
    ├── remote.ts           # push/fetch/pull/stash/branch/soft-reset/cherry-pick/revert/abort/rebase-continue
    ├── historyCompare.ts   # /history, /commits/:hash[/diff|/files], /branches, /base-branches, /compare[/base|/file]
    ├── explorer.ts         # /tree, /file (with ?symbols=true), /files
    ├── search.ts           # POST /repos/:id/search (POST on purpose: a GET would be a cross-site timing oracle)
    ├── journal.ts          # GET /repos/:id/journal?since=
    ├── blob.ts             # /blob (image bytes) + /media (per-side image metadata)
    ├── daemon.ts           # GET /events (daemon-scope SSE, optionally combined with one repo), /follow
    └── settings.ts         # /settings + /discovered + /browse (both API modes)

packages/client/src/
├── index.ts                # Public exports (DiffstalkerClient, wire types, isConnectionError)
├── client.ts               # DiffstalkerClient: typed methods for every endpoint + subscribe
├── transport.ts            # http-over-unix-socket / TCP fetch + SSE stream reader
└── wire.ts                 # Wire types + decoders (JSON dates/maps back to rich types)

packages/cli/src/
├── index.ts                # Entry point: CLI args, `link` dispatch, ensureDaemon, terminal cleanup, crash handlers
├── App.ts                  # Main controller: screen, RepoSession, listeners, render loop
├── commands/
│   └── link.ts             # `diffstalker link`: prints a verified web-UI URL, spawns no daemon
├── daemon/
│   ├── DaemonLifecycle.ts  # ensureDaemon: resolve socket, attach or spawn diffstalkerd (log file + rotation)
│   └── RepoSession.ts      # Client-side store for one repo: SSE + on-demand pulls, reconnect
├── KeyBindings.ts          # All keyboard bindings (screen-level), KeyBindingActions interface
├── MouseHandlers.ts        # Mouse event handling against layout regions
├── NavigationController.ts # Selection movement, scrolling, hunk navigation
├── StagingOperations.ts    # Stage/unstage/toggle operations, pending selection intents
├── ModalController.ts      # Single source of truth for modal state (ModalType union)
├── FollowMode.ts           # Reacts to the daemon's follow-change SSE -> repo switching
├── config.ts               # Config loading/saving (~/.config/diffstalker/config.json)
├── themes.ts               # Re-exports the shared themes from core/view/themes
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
├── utils/                  # CLI-only helpers (displayRows, explorerDisplayRows, ansi, ansiTruncate, syntaxHighlight, blessedRgbPatch, fileResolution)
└── types/                  # Shared type declarations (tabs, session, neo-blessed shim)

packages/web/src/
├── main.ts, App.vue        # Entry + shell
├── api/                    # Browser fetch + SSE client (client.ts, transport.ts, errors.ts)
├── stores/                 # Pinia: daemon, repo, worktrees, explorer, filter, settings, ui, failureLog
├── views/                  # ChangesView, CompareView, HistoryView, ExplorerView, JournalView
├── components/             # Diff stack, file tree, overlays (finder, search, hotkeys, settings), pickers, image views
├── composables/            # useUrlSync, useFollowMode, useAutoMode, useGlobalKeys, scroll/drag helpers, ...
├── utils/                  # diffRows/diffSplit/diffHighlight, hljs, refPair, listNav, imageRefusal, ...
├── theme/                  # Palette + theme CSS built on core/view/themes
└── prefs.ts                # Per-browser preferences (localStorage)
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

The web UI does the same job with Pinia stores (`stores/daemon.ts` owns the connection and the combined `GET /events?repo=` stream, one per tab; `stores/repo.ts` owns one repo's state and pulls).

### Daemon-side managers and events

Inside the daemon, `@diffstalker/core` keeps the EventEmitter managers: `GitStateManager` coordinates `WorkingTreeManager` (status+diff, git/working-dir watchers, `state-change`), `RemoteOperationManager` (push/fetch/pull/stash/branch, `remote-state-change`) and `JournalManager` per repo. The working tree emits a `journal-observation` per refresh; `GitStateManager` wires it into `JournalManager.observe`, which appends entries and emits `append`; the per-repo SSE hub fans `state-change` and `journal-append` out to clients. The journal store is injected and lives in the registry's LRU cache, so it outlives a close + reopen. History, compare, explorer and search have **no** managers — they are served statelessly from plain git fns. Never emit unsubscribed `'error'` events — an EventEmitter `'error'` without a listener crashes the process.

### Git Operations

Plain functions in `packages/core/src/git/` wrap simple-git. Mutations go through `GitOperationQueue` (one queue per repo) so operations serialize and refreshes coalesce; daemon route handlers call the owning manager (e.g. `WorkingTreeManager.stage`, which wraps the plain `stageFile`), which updates state and records the failure instead of throwing, then respond with the `{state, result?}` envelope (`routes/shared.ts` turns the recorded failure into the right HTTP status). `getStatus` returns `isRepo: false` only for a genuine non-repo; other failures propagate to keep the previous status visible.

### Symbols

Outlines are syntax only, never semantics. The engine (`core/symbols/extract.ts`) runs only inside the daemon's worker (`daemon/symbols/`): a cancelled parse poisons a tree-sitter parser, so the worker is discarded and respawned rather than reused, and the deadline is a host-side timer because the worker cannot bound itself. Clients read outlines from `GET /file?symbols=true`; a plain `/file` is byte-identical to before symbols existed. `GET /health` reports which extensions this install can outline.

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

## Errors and logging

`docs/logging.md` is the full reference. The short version:

- **Logger** (`@diffstalker/core/utils/logger`): one line per event to stderr — ISO timestamp, level, message, then `key=value` facts (`repo=`, `file=`, `route=`) and the error indented under it. Levels: `error` (unexpected; full stack of the error and every `cause`), `warn` (an operation failed and was handled; error and cause chain as one summary line each), `debug` (only with `--debug`). Control characters are escaped and `scheme://user:token@host` is scrubbed. The CLI's own `--debug` affects only the TUI's lines, not the daemon's.
- **Where logs go**: a daemon under the systemd user unit logs to the journal (`journalctl --user -u diffstalkerd`). A daemon the TUI spawned logs to `$XDG_STATE_HOME/diffstalker/diffstalkerd.log`; the spawn rotates it to `diffstalkerd.log.1` when it is over 1 MB, and refuses to spawn (naming the file) if it cannot open it. A daemon started by hand logs to its terminal. The web UI logs to the browser console.
- **Routes** throw `HttpError(status, message, { cause })`. Only the message reaches the client; everything else (a git command line, a path, an errno) stays in the log, because the daemon is reachable from a browser. The router logs a 500 with its stack at `error`, an `HttpError` that carries a `cause` or has a 5xx status at `warn` (with the cause under it), and a plain 4xx at `debug`.
- **Git mutation failures** are logged once by the manager that ran them, with the repo. `gitFailure` in `routes/shared.ts` therefore builds the `HttpError` from git's message with **no** cause — a cause there would log the same failure twice.
- **A repo whose directory vanished** or stopped being a repo: the manager logs it once and sets `unavailable`; `requireRepo` then answers 410 with that reason for every route that would run git. `requireRepoHandle` skips the check for the routes a client needs to learn that and let go — `GET /repos/:id/status`, `GET /repos/:id/events` and `DELETE /repos/:id`.
- **Web stores** log what they show: every error line the UI displays has a `console.error` behind it via `stores/failureLog.ts` (`logFailure`; `logDaemonRefusal` skips connection losses, which the reconnect path reports once).
- **Never swallow a real failure in an empty catch.** A quiet catch is only for a probe that expects to miss (a stat on a file that may not exist, `git check-ignore` exiting 1), and the comment at the catch says why.

## Common Tasks

### Adding a new git operation
1. Add the plain function to `packages/core/src/git/status.ts` (or `diff.ts`/`worktree.ts`)
2. Add a method on the owning manager in `packages/core/src/managers/` that runs it through the queue and updates state with error handling (only when the op needs live/queued state; stateless reads stay plain fns)
3. Add a daemon route in `packages/daemon/src/routes/` that calls it and returns the `{state, result?}` envelope. Decide which API mode routes it: mutations beyond file-level stage/unstage go on the `full` (socket) router only. Document it in the endpoint table in `packages/daemon/README.md`
4. Add a typed method to `DiffstalkerClient` in `packages/client/src/client.ts` (and its wire types in `wire.ts`)
5. Web: add it to `packages/web/src/api/client.ts` and call it from the owning Pinia store. CLI (only if the CLI needs it): call it from `RepoSession` (apply the returned envelope) and wire it from `App.ts` (action) + `KeyBindings.ts` (key)

### Adding a keybinding (CLI)
1. Add handler in `src/KeyBindings.ts` (respect the `hasActiveModal()` guard for non-modal keys)
2. Add the action to `KeyBindingActions` and implement it in `App.setupKeyboardHandlers()`
3. Update `Footer.ts` and `ui/modals/HotkeysModal.ts` to show the hint, and docs/FEATURES.md

Web keys live in `composables/useGlobalKeys.ts` (and `usePortraitKeys.ts`); the hint list is `components/HotkeysOverlay.vue`.

### Adding a modal (CLI)
1. Create a class in `src/ui/modals/` implementing the `Modal` interface
2. Add its `ModalType` and an `openX()` method in `ModalController.ts` (follow the toggle/guard pattern)
3. Trigger from `KeyBindings.ts` at screen level
4. Render happens via `ctx.render()` on close — do not skip it

## Gotchas

- **The web may import VALUES from core only out of browser-safe modules** (`view/*`, `types/*`, `git/diffParse`, `utils/blobRef`, `utils/imageSniff`, the pure `symbols/*`). A value import from `git/diff`, `git/status` or another Node-only module drags `node:*` into the browser bundle, where Vite stubs it and the page dies on load. Type-only imports are fine. `vite build` fails on any Node builtin (the `noNodeBuiltins` plugin in `packages/web/vite.config.ts`); the tests cannot catch it, since they run in Node. Shared runtime values live in `core/types/` (e.g. `types/compare.ts` for `NO_UNCOMMITTED`).
- Blessed: after `box.destroy()`, the screen must be explicitly re-rendered to clear visual artifacts
- Blessed: box-level key handlers fire before screen-level ones when the box has focus — but both fire (see Modals above)
- `setImmediate` hacks for race conditions are a code smell — use proper guards at the KeyBindings level
- Mouse coordinates from terminals are 1-indexed
- `simple-git` status may include gitignored files in some cases; we filter with `git check-ignore` (core/daemon)
- neo-blessed truecolor only works because of the runtime patch (`applyBlessedRgbPatch()` runs before screen creation); content SGR `38;2;R;G;B` codes are otherwise downsampled (CLI)
- Core manager tests must not create real chokidar watchers: construct `WorkingTreeManager` without calling `startWatching()`. The **one exception** is `packages/core/src/managers/WorkingTreeManager.watch.test.ts`, where the watcher is the thing under test: it calls `startWatching()` on purpose, runs each scenario in a child `bun test` process and SIGKILLs it after a hard timeout, because a process frozen in `open(2)` fires no timer and would hang the suite forever. Do not add a second such test; add scenarios there.
- Daemon tests are self-contained: each file creates its own daemon on a temp unix socket (or ephemeral TCP port) and its own fixture repo, with follow disabled unless follow is under test — then `--follow-file` points at a temp path, never the real default. Client tests spin up no watchers.
- CLI tests must not hit a real daemon: `RepoSession`/`App` tests drive a fake `DiffstalkerClient`, and `DaemonLifecycle` tests inject their deps (bin resolution, log file) and spawn nothing. If you ever need to stop a daemon you started for a manual test, target its socket or pid — never `pkill diffstalkerd`, which kills the user's live daemon.
- **Repo bytes are typed from magic bytes only.** The `content-type` on `GET /repos/:id/blob` comes from matching the bytes the route is about to write against the closed three-entry PNG/JPEG/GIF table in `@diffstalker/core/utils/imageSniff`, re-derived on every request — never from `path.extname()`, never from a query parameter, never from a verdict a `/file` or `/media` response cached. `staticFiles.ts`'s `CONTENT_TYPES` (which maps `.svg`, `.html`, `.wasm`) is for the SPA's own assets and **must never be reused for repo content**: a repo file named `logo.png` holding `<svg><script>` becomes same-origin script the moment its name is believed. Adding a format is a security review, not a table edit.
- A search endpoint must stay `POST`: `security.ts` exempts GET from the CSRF check, and repo ids are computable offline, so a GET search would be a cross-site timing oracle. The first test in `search.test.ts` fails if someone "corrects" it.

## Code Quality Guidelines

### Pre-commit Hook

A pre-commit hook runs `bun run lint` (ESLint + dependency-cruiser) before every commit. It lives in `scripts/githooks/pre-commit` and is activated via the `prepare` script after `bun install`. 18 pre-existing warnings are expected (5 in packages/core + 11 in packages/cli + 2 in packages/web; daemon and client 0), 0 errors. 15 of them are sonarjs cognitive-complexity and 1 is a core sonarjs no-nested-conditional; web's 2 are `vue/one-component-per-file` from the two inline test components in `src/composables/useActiveRowScroll.test.ts`.

### Architecture Layering (dependency-cruiser)

Each package has a `.dependency-cruiser.cjs` enforcing that lower layers do not import higher layers.

packages/cli:

```
index.ts
  ↓
App.ts, KeyBindings.ts, MouseHandlers.ts, NavigationController.ts,
StagingOperations.ts, ModalController.ts, FollowMode.ts
  ↓
daemon/   ui/   commands/
  ↓
state/
  ↓
utils/  types/  themes.ts  config.ts
```

The CLI is locked as a pure daemon client (severity `error`): `src/` may **not** import `@diffstalker/core/managers/*` (no in-process managers), `@diffstalker/core/symbols/extract` or `web-tree-sitter` (the engine runs only in the daemon's worker), nor `simple-git` / `chokidar` (daemon/core-only). It may still import the pure core helpers it uses (`view/*`, `git/diffParse`, `git/explorerStatus`, `git/status`/`worktree`/`diff` types, `services/commitService`, `symbols/{types,languages,mapping,vueBlocks}`, `utils`, `types`).

packages/core:

```
managers/
  ↓
git/  services/  symbols/  utils/  types/

view/   — browser-safe: imports git/, utils/ and symbols/ TYPES only
          (runtime exception: git/diffParse); nothing imports view/ except
          managers/ -> view/splitDiffByFile (the journal's per-file splitter)
```

`symbols/{types,languages,mapping,vueBlocks}` may not import `symbols/extract`, and `types/` imports nothing. `packages/core/src/symbols/depcruise.test.ts` proves the symbol rules actually fire by writing a violating file and asserting the report.

packages/web has the same locks as the CLI in its own config (`no-node-builtins`, `no-core-managers`, `no-symbol-engine`, `no-in-process-git`, `no-circular`).

Circular dependencies are forbidden (`no-circular`, severity `error`, in every
package's config). Each per-package `depcruise` scans only that package's `src/`,
so a cycle that spans packages would slip past all of them; a **root
`.dependency-cruiser.cjs`** closes that gap by scanning core, client, daemon and
cli together and resolving `@diffstalker/*` imports to source (via
`tsconfig.deps.json`); the web is bundled by Vite and is not part of that scan. Run
`bun run deps` (per-package + workspace) or `bun run deps:workspace` (cross-package
only) to check; both are part of `bun run lint`, so the pre-commit hook and CI
enforce them.

## Interactive Testing with tmux

Claude can run and interact with the terminal UI headlessly using tmux. This enables real integration testing without requiring a TTY. (The web UI is tested with vitest and, by hand, against `bun run serve` on `:17337`.)

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

Note: `--socket PATH` points the CLI at a `diffstalkerd` socket to attach to or spawn on; a daemon it spawns outlives the session (its log is `$XDG_STATE_HOME/diffstalker/diffstalkerd.log`). For scripted control against the daemon directly, `curl --unix-socket` its REST endpoints (see `packages/daemon/README.md`).

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
