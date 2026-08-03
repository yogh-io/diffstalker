# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The version indicator no longer freezes at whatever was true when the tab
  opened.** It was pulled only when the event stream connected, so a tab left
  open on a second monitor — the way this is meant to be used — never asked
  again and kept reporting "up to date" indefinitely. It now re-asks hourly
  while connected, and stops when the stream closes. The daemon still caches
  npm's answer for six hours, so this costs one local request an hour.
- **A tab now notices when the daemon under it was restarted on a new
  version.** The web UI ships inside the daemon package, so the daemon's own
  version identifies the bundle: when it changes, the page is older than the
  API it is calling and the status bar says so and asks for a reload. It never
  reloads on its own — this is a tool people leave open to keep looking at
  something.

## [0.10.0] - 2026-08-03

### Added

- **Images are shown, in the Explorer and in a diff.** A PNG, JPEG or GIF
  opens as a picture on a checkerboard stage instead of the "Binary file"
  note, with its format and pixel size in the header — plus a frame count
  for an animated GIF — and a `1:1` toggle between shrink-to-fit and actual
  size. In Changes, a changed image renders as a fixed-height card with both
  versions, in **Side by side**, **Swipe** or **Onion** mode (pure CSS, no
  canvas); swipe and onion need two pictures of the same shape, so they fall
  back to side by side when the two sides differ in size. The meta line
  carries what the picture cannot: each side's byte size, its short object id
  (or "working tree" for an uncommitted file), the byte delta when both sides
  exist and differ, and a "may be metadata only" hint when the pixel
  dimensions match but the bytes do not — because two identical-looking
  images can differ in EXIF or ICC and a reviewer must never conclude
  "nothing changed" from the picture alone. Web UI only; the terminal UI
  cannot draw pixels.
- **Two new daemon endpoints, `GET /repos/:id/blob` and
  `GET /repos/:id/media`**, on every listener. `/media` resolves the old and
  new side of a changed image server-side (renames included) and reports
  bytes, object id, dimensions or a refusal code; `/blob` serves the bytes
  themselves, and only to an `<img>` — a browser that names any other fetch
  destination, or a cross-site one, is refused. **Only PNG, JPEG and GIF are
  served, and the content type comes from magic bytes** re-derived from the
  exact buffer being written, on every request — never from the extension, a
  query parameter, or a cached verdict, because a repo file called
  `logo.png` holding `<svg><script>` is same-origin script the moment we
  agree with its name. Everything else gets zero bytes and a refusal. The
  daemon never decodes, transcodes or strips metadata: validation is
  fixed-offset reads and bounded walks, no image library enters the tree, and
  the browser stays the sandbox. The byte cap is checked before a byte is
  read, the pixel and frame caps before a byte is written — 8 MiB (2 MiB for
  GIF), 8192 px per side, 16 MPix, 256 frames — with the pixel budget as the
  real control, since a 300-byte PNG can declare 60000×60000. A GIF is
  charged frame by frame as well as in total: a frame's rectangle may legally
  be bigger than the picture it composites into, and a decoder allocates the
  rectangle. See `packages/daemon/README.md`.
- **One daemon serves the terminal UI and the browser at once.** `--socket`
  and `--port` are no longer mutually exclusive: the unix socket is the
  daemon's identity and is always bound (unless `--no-socket`), and `--port`
  adds the browser's transport on top. `diffstalkerd --port 7337` therefore
  gives one process, one git state, and one event stream that both clients
  observe — where previously a port bind replaced the socket, the CLI found
  nothing to attach to, and you ended up running two independent daemons
  whose states never agreed.
- **Least privilege is now decided per listener rather than per daemon.**
  Each transport gets its own routing table over the shared state, graded by
  how well it is protected: a unix socket (or an inherited activation fd) is
  owner-only at the filesystem layer and carries the full API, while a TCP
  port carries the web subset. Commit, discard, hunk staging and every
  remote/branch route are simply absent from a port's routing table, so a
  dual-bound daemon is still safe to point a browser at. `createDaemon({
  apiMode })` still forces one surface onto every listener, for embedders.
- **A systemd user service**, installed by the Arch package at
  `/usr/lib/systemd/user/diffstalkerd.service` —
  `systemctl --user enable --now diffstalkerd` and the web UI is at
  `http://diffstalker.localhost:7337/`. A user unit, not a system one: the
  socket lives under `$XDG_RUNTIME_DIR` and git runs as the invoking user.
  Not socket-activated, because a cold activated start overruns the CLI's
  250 ms health probe and the TUI would race it by spawning a second daemon.
- `--no-socket` (requires `--port`) for a browser-only daemon, and `--port 0`
  to let the kernel choose a free port — the daemon reports the one it got.
- **`diffstalkerd` takes repo paths on the command line.** `diffstalkerd
  --port 7337 .` now opens that repo before the daemon starts listening, so
  the browser has something to show the moment it connects instead of an
  empty daemon waiting for someone to POST `/repos`. A path is expanded
  (`~`), resolved against the current directory, and reported as it opens; a
  path that will not open stops the daemon with a message rather than leaving
  a half-set-up socket behind.
- **`--version` (and `-v`) on both commands.** `diffstalkerd --version`
  prints its version; `diffstalker --version` prints its own plus the
  `diffstalkerd` it would spawn and the runtime it is running under — the
  answer to "which install am I actually using" when npm, the AUR package and
  a `bun link` checkout are all on the same machine. It answers before any
  daemon contact, so it still works when nothing can start.

### Changed

- **The Explorer no longer browses the git directory.** `GET /repos/:id/file`
  and `/repos/:id/tree` now refuse any path whose normalized form contains a
  `.git` segment (`.git/config`, `./.git/config`, `src/../.git/config`,
  `.GIT/config`, `worktrees/x/.git/config`) and any path whose real location
  lands at or under this repository's **own** absolute git dir — which also
  catches a symlink pointing into it, the git dir of a linked worktree, and a
  submodule's `.git` file. Only those two rules are enforced: a repository
  committed into the working tree under some other name is still browsable,
  because it is tracked repo content, not the git dir of the repo being
  served. `/tree` drops the git directory from listings even with
  `hidden=true`. This was reachable before and served `.git/config`, which
  carries tokens embedded in remote URLs. The segment check runs on
  `path.relative(root, path.resolve(root, rel))`, over every segment, case
  insensitively and with trailing dots and spaces stripped; a check on the
  raw string's first segment misses all four spellings after the first.
- **`GET /repos/:id/tree?dir=.` is now a 400.** Path validation refuses a
  path whose normalized form is empty, and only `dir=` (the empty string) is
  special-cased as the repository root. The web UI sends the empty string, so
  nothing in it changes; a REST caller that spells the root as `.` — or as
  anything else that normalizes to it, like `src/..` — must send the empty
  string instead.
- **A large binary in the Explorer reads as "Binary file", not "File too
  large to display".** The 1 MB cap is the *text* cap, so it used to be
  reported for a 2 MB tarball as if a bigger budget would have shown you
  something — but a tarball was never displayable text. Whether a file over
  the cap is binary is now decided by the same NUL scan every other file
  gets, and only a binary one is called binary. Large *text* files are
  unchanged: a 2 MB README still reads as too large, which is the truth
  about it.
- **Tighter response headers on every daemon response.** The CSP gains
  `frame-src`, `child-src`, `media-src`, `worker-src` and `form-action`, all
  `'none'`, and `Cross-Origin-Resource-Policy: same-origin` is now set. The
  UI has no iframe, no media element, no worker and no form, so spelling them
  out costs nothing and makes a regression that adds one fail loudly.
  `img-src` stays `'self' data:` — deliberately no `blob:`, since a `blob:`
  URL inherits the page's origin.
- **An unknown option is now an error, not a repo path.** `diffstalker
  --port 7337` used to treat `--port` and `7337` as paths and try to open
  `./7337` as a repository; the failure named a directory you never
  mentioned. Any unrecognized argument starting with `-` now exits 2 with
  `unknown option`, and `--port` in particular says what to do instead (give
  it to `diffstalkerd`). A second repo path is an error too, instead of being
  silently dropped. `--socket` and `--instance` with no value still fail,
  now with the same message shape and exit code as every other usage error
  (2, was 1).
- **A relative repo path is refused instead of being resolved against the
  wrong directory.** The daemon used to resolve a path like `../foo` against
  **its own** working directory, which is not yours whenever you attach to a
  daemon that was already running — so it opened a different repository, or
  reported "Not a git repository" about a path you never typed. It now
  requires an absolute path and says so. A leading `~` is expanded first, and
  the not-a-repo message names the expanded path, so `~/code/x` no longer
  fails as the literal directory `~`.

### Fixed

- **A named pipe in the working tree no longer freezes the daemon.** Opening a
  FIFO blocks until something opens the other end to write, and the working-tree
  watcher opened whatever appeared. Under `bun` that block lands on the main
  thread, so one pipe created inside a watched repo stopped the daemon answering
  anything at all — `/health` included — while it still looked alive. The
  watcher now skips anything that is not a regular file or a directory. Node
  handles the same path without trouble, so a `diffstalkerd` installed from npm
  was never affected; `bun run dev` and `bun run serve` were.
- **A host name that merely begins with `127.` is no longer taken for
  loopback.** The daemon checks the `Host` header on every request so that a
  name an attacker owns cannot be pointed at the daemon's port and become
  same-origin with it — a DNS rebinding attack, which would hand a visited
  page the whole API. The check tested `startsWith('127.')`, and
  `127.0.0.1.evil.com` starts with `127.`. Only real loopback names are
  accepted now: an address in `127.0.0.0/8`, `::1`, `localhost`, and names
  under `.localhost`. This is pre-existing behaviour in the shipped daemon,
  not something the image endpoints introduced — it was found while reviewing
  them, and it applies to every route.
- **A 500 no longer tells the browser what git was asked and what it
  answered.** An error no route classified had its message copied into the
  response body, and a failed git call carries the whole command line and
  git's stderr with it — absolute paths, branch and remote names, object ids.
  An unexpected 500 now says only that the request failed; the detail is the
  daemon's to report, not the browser's to read. Deliberate errors are
  unchanged: a 400, 404, 413 or 415 still says exactly what was wrong,
  because the caller needs that.
- **A renamed file now says where it came from.** `FileEntry.originalPath` was
  declared and read — the terminal file lists have always had an `← old/path`
  suffix for it — but `getStatus` never populated it, so the suffix never
  appeared and the pre-rename blob had no route back. It is now filled from
  git's own rename/copy record on the index side (the working-tree column
  never carries `R` or `C`, so only the staged entry can carry it). This lets
  a renamed image resolve its old side: HEAD has never heard of the new name.
- **An untracked binary file no longer renders as mojibake.** A newly added
  PNG is the most common image in a diff, and `getDiffForUntracked` read
  every untracked file as UTF-8 and emitted each line as an addition — so it
  arrived as a wall of replacement characters and never reached the binary
  path. Untracked files are now read as bytes and classified by a NUL scan
  (the same test the Explorer uses), and a binary one gets git's own marker,
  `Binary files /dev/null and b/logo.png differ`. Text files are byte-for-byte
  unchanged.
- **The AUR package now warns before pacman's "exists in filesystem" abort.**
  Installing over a previous `npm install -g diffstalker` fails because npm's
  prefix on Arch is `/usr`, leaving `/usr/bin/diffstalker` owned by no
  package. Nothing in a package can clear that at install time — the
  file-conflict check gates the transaction ahead of every scriptlet and
  hook — so the PKGBUILD checks at build time instead and prints the exact
  remedy, in `prepare()` and again at the end of `package()`. Detects the
  dangling symlink a stale `npm link` leaves behind, which `test -e` alone
  reports as absent.
- **Line numbers after "\ No newline at end of file" are right again.** The
  marker is git's note about the line above it, not a line of either file,
  but it was counted as one — so every line after it in the hunk was
  numbered one too high on both sides, and in side-by-side view the left and
  right gutters stopped agreeing. It now takes no number and shifts nothing.
  The two versions of a changed last line also stay on one row again, with
  their word-level highlighting, instead of being split apart by the marker
  standing between them; and the marker is shown on the side it is actually
  about, rather than on both, so it no longer claims a missing newline for
  the file that has one.
- **A `chmod +x` reads as a mode change instead of two lines of file
  content.** `old mode 100644` / `new mode 100755` were not recognized as
  diff headers, so they were rendered as context lines of the file itself,
  numbered from 0. Renames, copies and dissimilarity headers are recognized
  in the same place now — there were two header lists that had drifted apart,
  and there is one.
- **A file with merge conflicts is marked as conflicted.** An unmerged path
  used to read as an ordinary modify, add or delete, so nothing told you it
  was the file holding up the merge. It now carries its own status: `U` in
  the file lists and the Explorer, in its own colour, in both the browser and
  the terminal. In the browser its stage/unstage button is disabled and says
  why — `git add` on an unmerged path claims a resolution that has not
  happened, and unstaging throws away the conflict stages.
- **A huge untracked file no longer claims to be empty, or stalls the file
  list.** Every untracked file was read whole just to count its lines, so a
  405 MB log was loaded into memory and reported as `+0 −0`. Files over the
  diff size cap (256 KB — the same cap the untracked diff already used) are
  no longer read, and show no line counts at all rather than zeros.
- **A refused stage or unstage stays on screen.** The message git gave back
  was wiped by the next state change — often within a fraction of a second,
  since staging is exactly what triggers one — so the button appeared to do
  nothing at all. The refusal now names the action and the file (`Could not
  stage a.ts: …`) and stays until it is genuinely over: the file reaches the
  side you asked for, you try again, or a more urgent problem replaces it.
- **A journal timestamp older than an hour says which day it is.** The
  relative time ("5 minutes ago") freezes into a clock time at an hour old,
  and that clock time was a bare `14:32` whatever day it belonged to.
  Anything not from today now carries its date, and its year when that
  differs too.

### Internal

- **The release gate now boots the packed tarballs under Node.** Every step
  before it runs under bun, so nothing ever executed the published Node
  program on the runtime its users have. The new step installs both tarballs
  with npm into a clean directory, starts the daemon, and checks that `GET /`
  is really the web UI and that every asset it references returns 200 — on
  the engines floor (20.19.0) as well as current Node. It also catches a
  daemon tarball built without `build:prod`, which ships without the web
  assets, installs cleanly, and then fails on first run.
- **The README states the platform.** Linux is what diffstalker is built and
  tested on. macOS needs an explicit `--socket` because it does not set
  `XDG_RUNTIME_DIR`, and native Windows is not supported; use WSL2.
- **Three CLI test files were never being run.** The test script globbed
  `src/*.test.ts src/**/*.test.ts`, which the shell expands one directory
  deep, so everything under `src/ui/widgets/` was skipped in CI and in the
  pre-push hook. All packages now run `bun test src/`, which lets bun do the
  discovery.

## [0.9.0] - 2026-07-28

### Fixed

- **A worktree is named by its directory everywhere, and its branch is
  never hidden.** The switcher's trigger showed the directory while its
  rows showed the branch, so a `main` worktree with a feature branch
  checked out read as two different names depending on where you looked.
  Worse, the header suppressed the branch name in the breadcrumb whenever
  it matched "what the switcher shows" — computed the row way, not the
  trigger way — so in exactly that case the current branch appeared
  nowhere in plain text. The switcher now names the PLACE (the directory)
  in both, and a row carries the checked-out branch on its own line when
  it differs from the directory name; a detached worktree says "detached"
  in its meta line. The breadcrumb states the branch whenever the switcher
  is not already showing that exact word.
- **The upstream shortens to its remote when it adds nothing.** A branch
  tracking the same name upstream printed it twice
  (`aer-4569-x → origin/aer-4569-x`); it now reads `aer-4569-x → origin`,
  with the full ref on hover. A genuinely different upstream branch
  (`main → upstream/release-2025.1`) is still spelled out.
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
