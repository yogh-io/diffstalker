# diffstalkerd

`diffstalkerd` is the diffstalker daemon: a Node http server that exposes
`@diffstalker/core` (git status, diffs, staging, live change events) behind a
REST API + Server-Sent Events. It lets non-terminal clients (editors, web UIs,
scripts) talk to the same git state engine the TUI uses.

Published to npm as `diffstalkerd`, bin-only: it exposes the `diffstalkerd`
executable, not an importable API. The `diffstalker` CLI depends on it and
pulls it in automatically, so most users never install it directly.

Its primary client is the `diffstalker` CLI (`packages/cli`), which spawns or
attaches to this daemon over a unix socket and consumes it through the typed
`@diffstalker/client`. A read-only web UI (Vue) ships inside this package and is
served at `GET /` when the daemon binds a TCP port (`--port N`) — same-origin,
since a browser can't reach the unix socket and the daemon sends no CORS headers.

## Running

From the repo root:

```bash
bun packages/daemon/src/index.ts            # development (source)
bun run build                               # compile all packages
node packages/daemon/dist/index.js          # run the compiled daemon
packages/daemon/bin/diffstalkerd            # same, via the bin wrapper
```

Options:

```
--socket PATH        Bind a unix socket at PATH
--instance NAME      Bind <NAME>.sock in the runtime dir, so several daemons
                     can run side by side (clients select it with the same
                     name: diffstalker --instance NAME)
                     (default: $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock)
--no-socket          Do not bind a unix socket (requires --port)
--port N             Also bind TCP port N (loopback only) for the web UI.
                     The port serves the web API subset; the unix socket
                     keeps the full API
--follow-file PATH   Hook file to follow (created when missing)
                     (default: ~/.cache/diffstalker/target)
--no-follow          Disable follow mode (no hook-file watcher)
--web-root PATH      Directory of built web-UI assets to serve at GET /
                     (default: ./web next to the daemon bundle; the published
                     package ships it there. Missing dir → API-only, non-fatal)
--no-update-check    Never ask npm which version is latest; GET /version
                     then reports the running version only
--help, -h           Show this help
```

`--socket` and `--port` are **not** mutually exclusive — binding both is the
normal deployment. The unix socket is the daemon's identity (one per user) and
is always bound unless `--no-socket`; `--port` adds the browser's transport on
top, over the same git state. `--follow-file` and `--no-follow` are exclusive,
as are `--socket` and `--no-socket`.

```bash
diffstalkerd --port 7337      # socket for the TUI + :7337 for the browser
```

That single daemon is what both clients talk to: `diffstalker` finds the socket
and attaches instead of spawning its own, so the TUI and the browser observe one
state over one event stream. Binding only a port (`--no-socket --port N`) leaves
the CLI nothing to attach to, and it will start a second, separate daemon.

A browser can only reach the daemon over TCP (`--port`), not a unix socket, and
the daemon sends no CORS headers — so the web UI is served same-origin from the
daemon itself. `GET /` and any unmatched non-API GET path return the SPA's
`index.html` (client-side routing); hashed `/assets/*` are served with a long
immutable cache. The REST/SSE API always takes precedence over static files.

Without `--socket`, the daemon binds a unix socket at
`$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock`. The directory is created
with mode `0700` and the socket is chmod'd to `0600` (owner only). If
`XDG_RUNTIME_DIR` is unset, the daemon refuses to start — there is
deliberately no `/tmp` fallback. Pass `--socket PATH` explicitly instead.
(With a `--port` to fall back on, an unset `XDG_RUNTIME_DIR` is a warning
rather than a failure: the web UI still works, only the CLI transport is
missing.)

`--port 0` asks the kernel to pick a free port; the daemon prints the one it
actually got.

If a live daemon already answers on the socket path, startup fails; a stale
socket file (nothing listening) is removed and reused.

The daemon has no authentication, so it binds **loopback only** — a unix
socket, or `--port` on `127.0.0.1`. There is no option to bind a routable
interface (bearer-token auth would be a prerequisite for that, and is not
implemented). On a port an
origin guard runs: a `Host` allow-list rejects rebound hostnames
(DNS-rebinding defense, 421), and state-changing requests with a cross-site
`Sec-Fetch-Site` or a non-loopback `Origin` are rejected (CSRF defense,
403). Non-browser clients (the CLI, `curl`) send neither header and a
loopback `Host`, so they pass. Every response also carries hardening
headers (`X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy`, and a strict `Content-Security-Policy` for the served
SPA). To reach the daemon from another machine, forward the port over SSH
(`ssh -L`). See `SECURITY.md` at the repo root.

The API surface is chosen **per listener**, by how well that transport is
protected — not per daemon. A unix socket (or an inherited activation fd) is
owner-only at the filesystem layer and carries the **full** API. A TCP port is
reachable by any process on the host and carries a **reduced** API (least
privilege): only the endpoints the web UI uses — reads, `POST`/`DELETE /repos`,
and `POST /repos/:id/stage`/`unstage`. The CLI-only mutations (commit, discard,
hunk staging, `PUT /compare/base`, and every remote/branch operation) are not
routed on a port at all; requesting one there returns `404 Unknown route`.

So a daemon bound to both transports simultaneously is still safe to expose to a
browser: the write-capable surface stays behind `0600` file permissions, and no
origin-guard bypass can reach it, because those routes are not in the port's
routing table to begin with. Each listener gets its own routing table over one
shared registry, SSE hub and follow controller.

Embedders can override this with `createDaemon({ apiMode })`, which forces one
surface onto every listener regardless of transport.

## Environment

- `XDG_RUNTIME_DIR` — base for the default socket path. Required when no
  `--socket`/`--port` is given.
- `XDG_CACHE_HOME` — base for the default follow hook file
  (`$XDG_CACHE_HOME/diffstalker/target`, falling back to `~/.cache`).
- `LISTEN_FDS` / `LISTEN_PID` — systemd socket activation. When systemd hands
  the process a pre-bound socket (`LISTEN_PID` matches and `LISTEN_FDS >= 1`),
  the daemon listens on the inherited fd (fd 3) and does not create, chmod, or
  unlink any socket file. An explicit `--socket` (or `--no-socket`) takes
  precedence; `--port` does not suppress it, since the port is additive.
  Only fd 3 is used — a `.socket` unit with several `ListenStream=` entries
  would have all but the first ignored.

## systemd (user service)

The Arch package installs a **user** unit at
`/usr/lib/systemd/user/diffstalkerd.service`:

```bash
systemctl --user enable --now diffstalkerd
# web UI at http://diffstalker.localhost:7337/
```

It runs `diffstalkerd --port 7337`, which binds the default unix socket *and*
the port — so the terminal UI attaches to the same daemon the browser is
talking to, and `systemctl --user status diffstalkerd` is the whole story.

A **user** unit, never a system one: the socket lives under `$XDG_RUNTIME_DIR`
(per-user, `0700`), and every git call runs as the invoking user with their
config, ssh keys and worktrees. A system service would be the wrong uid for
all three.

Deliberately **not** socket-activated, even though the daemon implements the
`sd_listen_fds` protocol. The CLI health-probes the socket with a 250 ms budget
before falling back to spawning its own daemon; a cold activated start overruns
that, so the TUI would try to spawn a second daemon and hit `already running`.
An always-warm service answers the probe immediately. The daemon also has no
idle timeout — it holds watchers on open repos and is meant to stay warm for
the session — so lazy activation buys little here.

## API

Current surface. All bodies are JSON; errors are non-2xx with `{"error": "..."}`.

Naming rule: mutations are `POST /repos/:id/<verb-kebab>` (`switch-branch`,
`soft-reset`, `stage-hunk`); nouns with GET/PUT (`/branches`,
`/compare/base`) are resources.

Every mutation responds with the unified envelope `{state, result?}`:
`state` is the refreshed shared state (same shape as `GET /status`) and
`result` is the optional human-readable outcome text of remote/branch/undo
operations. Status codes: 400 for invalid input (missing fields,
flag-shaped refs, resets past the root), 404 for unknown repo ids / files
not in status, 409 when the repo state refuses the operation (conflicts,
rejected pushes, an operation already in progress, nothing to abort), 500
for real failures.

Ref-like fields (`name`, `hash`, `branch`) must not start with `-`; such
values are rejected with a 400 so they can never be parsed as git flags.

### Reads

| Method | Path                       | What                                             |
| ------ | -------------------------- | ------------------------------------------------ |
| GET    | `/health`                  | `{ok, ready}`                                    |
| GET    | `/version`                 | `{current, latest, status}` — the running version against npm's `latest` dist-tag (`current` \| `outdated` \| `ahead` \| `unknown`). The npm lookup is cached (6h, 5min after a failure) and only ever runs when this endpoint is called; `--no-update-check` skips it, leaving `latest: null` |
| GET    | `/repos`                   | List open repos (`id`, `path`, `branch`)         |
| POST   | `/repos`                   | Open a repo: `{"path": "/abs/path"}` → `{id, path}` (201 created, 200 already open) |
| DELETE | `/repos/:id`               | Close a repo (refcounted per open)               |
| GET    | `/repos/:id/worktrees`     | Registered worktrees (`path`, `branch`, `head`, `isBare`, `lastActivity`, `aheadOfBase`): main worktree, linked worktrees, and the bare entry in a bare-worktree layout |
| GET    | `/worktrees?path=`         | Same as above, but for a raw filesystem path instead of an already-opened repo id (e.g. a recently-visited repo a client hasn't opened on this daemon) |
| GET    | `/repos/:id/status`        | Shared state: status, hunk counts, stash list, in-progress operation, error, working-file mtimes (path → mtimeMs; what browser clients build mtime-based auto mode on) |
| GET    | `/repos/:id/diff?path=&staged=` | Diff; whole tree without `path`, staged side with `staged=true`. Per-file cap: a file's diff over 256 KB or 5,000 lines is withheld — its headers are kept and its body becomes one `Large file — diff not shown (…)` line, the same shape git uses for `Binary files … differ`. Applies to every diff-bearing response (compare, commit diffs, journal) |
| GET    | `/repos/:id/history?count=` | Commit history (`CommitInfo[]`, default 100, ISO dates) |
| GET    | `/repos/:id/commits/:hash` | One commit by hash or short hash (404 on unknown) — what a link to a commit outside a client's loaded log resolves through |
| GET    | `/repos/:id/commits/:hash/diff` | Diff introduced by one commit (404 on unknown hash; merge and `--allow-empty` commits are 200 with an empty diff, matching the CLI) |
| GET    | `/repos/:id/head-message`  | HEAD commit message for amend prefill: `{message}` (`""` when the repo has no commits) |
| GET    | `/repos/:id/branches`      | Local branches (`name`, `current`, `tracking`)   |
| GET    | `/repos/:id/base-branches` | Candidate compare bases (remote branches in recent history) |
| GET    | `/repos/:id/compare/base`  | Effective compare base: `{base}` (persisted choice or discovered default, null when none) |
| PUT    | `/repos/:id/compare/base`  | Persist the compare base: `{"branch": "origin/main"}` → `{base}`; the ref is validated first (400 on an unknown ref, nothing persisted) |
| GET    | `/repos/:id/compare?base=&uncommitted=` | Base-vs-HEAD `CompareDiff` (three-dot); base defaults to the effective base — a stale persisted base falls back to the discovered default, 422 when nothing usable resolves; an explicit unknown `base` is a 400; a base with no common history is a 422; `uncommitted=true` merges working-tree changes |
| GET    | `/repos/:id/tree?dir=&hidden=&ignored=` | One directory level (`name`, `path`, `type`), gitignored/hidden filtered by default (`hidden=true` / `ignored=true` include them, mirroring the TUI toggles), files annotated with `gitStatus` + `staged`, changed dirs with `hasChanges` (400 outside the repo root, on a file, or on the git directory, 404 unknown dir). The git directory is never listed, even with `hidden=true` |
| GET    | `/repos/:id/file?path=`    | File content for display with flags: `{content, binary, truncated, tooLarge, size, totalLines, media?}` — binary/oversized come back with empty content and the flag set, never prose; `media` carries the image verdict (`{image, refusal, version}`) when the bytes say something about it; 400 for anything that is not a regular file (directory, FIFO, device), resolves outside the repo root, or addresses the git directory |
| GET    | `/repos/:id/media?path=&staged=` | Image metadata for one changed file, both sides resolved server-side (renames included): `{old, new}`, each side `{path, side, bytes, oid, image, refusal, version}` or `null` when the file does not exist there. `staged` must be spelled `0` or `1`. 404 when the path is not in status. See [Image bytes](#image-bytes) |
| GET    | `/repos/:id/blob?path=&side=&v=` | Raw image bytes for `<img src>`; `side` is `worktree` \| `index` \| `head`, `v` is an ignored cache key. Only PNG/JPEG/GIF, typed from magic bytes. Status-independent (no `git status`), so a clean committed image is reachable. See [Image bytes](#image-bytes) |
| GET    | `/repos/:id/files`         | All tracked + untracked (not ignored) paths: the fuzzy-finder source |
| GET    | `/repos/:id/journal?since=` | Append-only edit journal: `{epoch, prunedBefore, entries}`; `since=<seq>` returns only entries with a higher seq (all when omitted) |
| GET    | `/repos/:id/events`        | SSE: `snapshot` on connect, then `state-change` events from the file watcher and `journal-append {entries}` per journal observation |
| GET    | `/events`                  | Daemon-scope SSE: `snapshot` (open repos) on connect, then `repo-opened` / `repo-closed` / `follow-change` |
| GET    | `/follow`                  | Follow state: `{targetFile, enabled, followedRepoId, followedPath}` |

### Mutations (all respond `{state, result?}`)

| Method | Path                       | Body / behavior                                  |
| ------ | -------------------------- | ------------------------------------------------ |
| POST   | `/repos/:id/stage`         | `{"path": "file.txt"}` — stage one file (404 when not in status) |
| POST   | `/repos/:id/unstage`       | `{"path": "file.txt"}` — unstage one file        |
| POST   | `/repos/:id/stage-all`     | Stage everything                                 |
| POST   | `/repos/:id/unstage-all`   | Unstage everything                               |
| POST   | `/repos/:id/discard`       | `{"path": "file.txt"}` — discard an unstaged change / delete an untracked file; 409 on a staged file (unstage first) |
| POST   | `/repos/:id/stage-hunk`    | `{"patch": "<unified diff>"}` — apply one hunk to the index; a stale patch is a 409 |
| POST   | `/repos/:id/unstage-hunk`  | `{"patch": "<unified diff>"}` — reverse-apply one hunk |
| POST   | `/repos/:id/commit`        | `{"message": "...", "amend"?: bool}` — 400 on an empty message or nothing staged; a commit that creates no commit is never a 200 |
| POST   | `/repos/:id/push`          | Push the current branch; rejected push is a 409  |
| POST   | `/repos/:id/fetch`         | Fetch from the remote                            |
| POST   | `/repos/:id/pull`          | Pull with rebase; a conflict is a 409 and leaves the repo mid-rebase — see `/abort` |
| POST   | `/repos/:id/stash`         | `{"message"?: "..."}` — stash the working tree   |
| POST   | `/repos/:id/stash-pop`     | `{"index"?: 0}` — pop a stash entry (see `stashList` in the state); a conflicting pop is a 409 and keeps the entry |
| POST   | `/repos/:id/switch-branch` | `{"name": "main"}` — switch branches             |
| POST   | `/repos/:id/create-branch` | `{"name": "feat-x"}` — create and switch         |
| POST   | `/repos/:id/soft-reset`    | `{"count"?: 1}` — move HEAD back, keep changes staged; past the root commit is a 400 |
| POST   | `/repos/:id/cherry-pick`   | `{"hash": "abc123"}` — apply a commit; a conflict is a 409 |
| POST   | `/repos/:id/revert`        | `{"hash": "abc123"}` — revert a commit with a new commit |
| POST   | `/repos/:id/abort`         | Abort whatever multi-step operation the repo is stopped in (rebase, cherry-pick, revert, merge); 409 when nothing is in progress |
| POST   | `/repos/:id/rebase-continue` | Continue a stopped rebase after conflicts are resolved and staged; 409 when no rebase is in progress |

A conflicted `pull`/`cherry-pick` leaves the repo stopped mid-operation;
`GET /status` reports it in `operationInProgress` and `POST /abort`
returns the repo to its pre-operation state — no shell required.

History, compare, and explorer data are stateless, pulled on demand: the
daemon never holds a client's selection, loaded history, or tree expansion.
A commit or branch switch fires the working-tree `state-change` event (the
git watcher covers HEAD/refs), which is the client's signal to re-pull.

Note on `/file`'s `truncated` flag: it strictly means the content was cut
at the display line limit. A merely large file that fits within the limit
is served whole with `truncated: false` (the old TUI code conflated the
two: a >100KB file used to be flagged truncated regardless).

Repo ids are stable hashes of the worktree root, so a cached id still
addresses the same repo after a daemon restart.

### Journal

`GET /repos/:id/journal` serves the repo's append-only edit journal: an
immutable, seq-ordered log of per-hunk diff blurbs plus boundary dividers
(commits, checkouts, stashes, operation transitions). Entries are
JSON-native; the embedded `diff` is a `DiffResult` in the same wire shape
as `/diff` responses.

- `entries` — those with `seq > since` (all when `since` is omitted);
  `seq` is the only ordering axis, `ts` (epoch ms) is a display label.
- `epoch` — opaque string minted per journal store. A mismatch with a
  client's cached epoch means the store was reset (daemon restart, LRU
  eviction): discard the cache and refetch from scratch.
- `prunedBefore` — highest pruned seq, 0 when nothing is pruned. A value
  above a client's last seen seq is a gap `?since` can never fill: full
  refetch.

New entries stream as `journal-append {entries}` on the per-repo
`GET /repos/:id/events` channel, one event per observation (possibly
several hunks), batched so clients apply them atomically.

The journal store lives above the repo's manager lifecycle: closing a
repo's last client (a browser F5) disposes the manager but keeps the
store, so a reopen resumes the same chronology under the same epoch.
Stores are LRU-capped daemon-wide; an open repo's store is never evicted.

## Image bytes

`GET /repos/:id/blob` is the only endpoint that hands raw repository bytes to a
browser, and `GET /repos/:id/media` is the metadata that tells the web UI which
bytes to ask for. Both are routed on **every** listener (the socket and the
port), because the web UI is what needs them.

The rule the whole design rests on: **what we say a file is comes from its
magic bytes**, re-derived from the exact buffer the route is about to write, on
every request. Never from the extension, never from a query parameter, never
from a verdict an earlier `/file` or `/media` response cached. A repo file
called `logo.png` holding `<svg><script>` is same-origin script the moment we
agree with its name, so it gets zero bytes and a 415.

### Allow-list

Three formats, and nothing else is ever served:

| Format | Content-Type | Structural gate |
| ------ | ------------ | --------------- |
| PNG (still) | `image/png` | PNG signature, `IHDR` dimensions, a legal bit-depth/colour-type pair, a bounded walk to the first `IDAT`. An `acTL` chunk (APNG) is refused — it is a second animation decoder |
| JPEG (baseline / progressive) | `image/jpeg` | SOI plus a legal marker, a bounded segment walk to the first SOF; **SOF0/SOF1/SOF2 only** (lossless, arithmetic and hierarchical SOFs are refused) |
| GIF (still or animated) | `image/gif` | `GIF87a`/`GIF89a`, a walk over the whole block stream counting image descriptors. Validated only with the entire file in hand, which is what `MAX_GIF_BYTES` bounds |

Everything else is refused by default: SVG, HTML/XML, PDF, WebP, AVIF/HEIC,
TIFF, BMP, ICO, JPEG XL, fonts, wasm/ELF/PE, archives, video and audio, and
anything unrecognized or recognized-but-invalid. The daemon **never decodes,
transcodes, re-encodes or strips metadata** — validation is fixed-offset
integer reads and bounded walks. No image library (sharp, jimp, canvas,
libvips) is a dependency of any package, and the browser stays the sandbox.

### Caps

Enforced before any byte is written, and again on the buffer being written:

```
MAX_IMAGE_BYTES     = 8 MiB    any allowed format
MAX_GIF_BYTES       = 2 MiB    GIF only, bounds the frame walk
MAX_IMAGE_DIMENSION = 8192     px per side
MAX_IMAGE_PIXELS    = 16 MPix  width * height, and any one GIF frame rect
MAX_GIF_FRAMES      = 256
MAX_ANIMATED_PIXELS = 32 MPix  frames * screen, and the sum of the frame rects
MAX_ICC_BYTES       = 64 KiB   PNG iCCP / JPEG APP2 run
```

The **pixel budget, not the byte cap, is the real control**: compression ratio
is unbounded, so a 300-byte PNG can declare 60000×60000 and cost the renderer
gigabytes of RGBA. `MAX_FILE_SIZE` (1 MiB) is untouched — that is the *text*
cap for `/file`.

A GIF declares its dimensions twice — the logical screen in the header, and a
rectangle on every frame's image descriptor — and a rect may legally be bigger
than the screen it composites into. So both are charged: every rect against the
per-side and per-image caps a still image gets, and the sum of the rects against
the animated cap on top. Checking the header alone would let a 1×1 GIF carry an
8000×4000 frame.

Concurrency is bounded too: 4 requests in flight per daemon with a queue of 64
waiters, then 503. One budget for the whole daemon, shared by every listener
**and by both endpoints** — `/media` inspects up to two sides, so it costs the
same spawns and the same buffers as `/blob` and takes the same slot. One
changed binary file costs up to three of those requests: a `/media` for the
verdict plus a `/blob` per side.

A slot is held until the response is finished on the socket, not just until the
read is done: the bytes stay resident while the client drains them, so an
earlier release would bound reads and leave memory unbounded. The release is
wired to the request **and** the response, because the two runtimes report the
end differently — node destroys the response when a client aborts, while bun
signals the abort only on the request. Every path either ends the response or
destroys the request, so the slot always comes back.

The two endpoints read different amounts, but they always reach the **same
verdict** about what a file is. `/media` only reports that verdict, so it reads
the window that decides the file and no more — a 64 KiB header for PNG and
JPEG, the whole file for a GIF, whose frame walk spans it. When that window is
inconclusive (a JPEG whose frame header sits behind a maximal EXIF segment, say)
the read is extended to the whole blob, which `MAX_IMAGE_BYTES` already bounds,
so `/media` never refuses a file `/blob` would serve. Only `/blob` reads the
bytes it is going to write.

### Refusals

| Status | Cause |
| ------ | ----- |
| 400 | empty/NUL path, a leading `-` (git option) or `:` (pathspec magic), traversal, a symlink escaping the root, any `.git` path, a non-regular file (directory, symlink, gitlink, FIFO), a bad `side`, a `staged` that is not `0`/`1` |
| 403 | `Sec-Fetch-Site` present and cross-site, or `Sec-Fetch-Dest` present and not `image` (`/blob` only — `/media` is JSON and the SPA's own `fetch` sends `Sec-Fetch-Dest: empty`). Both absent passes, so `curl` and the Node client are unaffected |
| 404 | unknown repo, or the path does not exist on that side. `/media` also 404s a path with no status entry |
| 413 | over the byte, dimension, pixel or frame cap |
| 415 | not allow-listed, or the signature matched and the structure failed. An APNG lands here too: it is not over any budget, it is a format we refuse |
| 421 | non-loopback `Host` (the global origin guard) |
| 503 | the blob queue overflowed |

Every refusal writes **zero bytes** and a plain `{"error": "..."}` body.

A 200 carries the magic-derived `content-type`, `content-disposition: inline`
with **no** `filename` parameter (a repo-supplied string is never interpolated
into a header), a re-asserted `x-content-type-options: nosniff`,
`cross-origin-resource-policy: same-origin`, `vary: sec-fetch-site,
sec-fetch-dest`, and either `cache-control: no-store` (`side=worktree`, whose
bytes can change under us) or `cache-control: private, no-cache` plus an
`etag` of the object id (`side=index|head`, which are immutable).

## Follow mode

The daemon owns the truth, clients decide policy. It watches ONE hook file
(`--follow-file`, default `~/.cache/diffstalker/target`; created when
missing); external tools append a repo or file path to it to signal "focus
this". On change the daemon resolves the path to a worktree root (same
normalization as `POST /repos`, including bare containers), auto-opens the
repo, and broadcasts `follow-change {repoId, path, rawContent}` on
`GET /events` — `path` is the resolved hook-file content (it may point at a
file inside the repo), `rawContent` the literal line. Content that does not
resolve to a git repository broadcasts nothing and leaves the follow state
untouched.

The daemon holds one internal "follow" reference on the followed repo so it
stays open with no clients attached; switching targets releases the previous
follow-ref (closing that repo when nothing else holds it — clients see
`repo-closed`). Whether a client reacts to `follow-change` is entirely
client-side; the daemon keeps no per-client follow state. A daemon restart
re-follows whatever the hook file last pointed at. `GET /follow` reports the
current state; with `--no-follow` it reports `{enabled: false}` and no
watcher exists.

Examples over the default unix socket:

```bash
SOCK="$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock"

curl --unix-socket "$SOCK" http://localhost/health
curl --unix-socket "$SOCK" -X POST -d '{"path": "/home/me/repo"}' http://localhost/repos
curl --unix-socket "$SOCK" http://localhost/repos/<id>/status
curl --unix-socket "$SOCK" 'http://localhost/repos/<id>/diff?path=file.txt'
curl --unix-socket "$SOCK" -X POST -d '{"path": "file.txt"}' http://localhost/repos/<id>/stage
curl --unix-socket "$SOCK" -N http://localhost/repos/<id>/events
curl --unix-socket "$SOCK" -N http://localhost/events
curl --unix-socket "$SOCK" http://localhost/follow
```
