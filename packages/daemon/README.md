# @diffstalker/daemon

`diffstalkerd` is the diffstalker daemon: a Node http server that exposes
`@diffstalker/core` (git status, diffs, staging, live change events) behind a
REST API + Server-Sent Events. It lets non-terminal clients (editors, web UIs,
scripts) talk to the same git state engine the TUI uses.

The package is private and bin-only: it is not published and not importable.
The only entry point is the `diffstalkerd` executable.

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
--socket PATH   Bind a unix socket at PATH
                (default: $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock)
--port N        Bind TCP port N instead of a unix socket
--host H        Host to bind with --port (default: 127.0.0.1)
--help, -h      Show this help
```

`--socket` and `--port` are mutually exclusive.

Without `--socket`/`--port`, the daemon binds a unix socket at
`$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock`. The directory is created
with mode `0700` and the socket is chmod'd to `0600` (owner only). If
`XDG_RUNTIME_DIR` is unset, the daemon refuses to start — there is
deliberately no `/tmp` fallback. Pass `--socket PATH` explicitly instead.

If a live daemon already answers on the socket path, startup fails; a stale
socket file (nothing listening) is removed and reused.

There is no authentication yet. Keep the daemon on a unix socket or
localhost; a bearer-token check is planned before it may bind further.

## Environment

- `XDG_RUNTIME_DIR` — base for the default socket path. Required when no
  `--socket`/`--port` is given.
- `LISTEN_FDS` / `LISTEN_PID` — systemd socket activation. When systemd hands
  the process a pre-bound socket (`LISTEN_PID` matches and `LISTEN_FDS >= 1`),
  the daemon listens on the inherited fd (fd 3) and does not create, chmod, or
  unlink any socket file. Explicit `--socket`/`--port` takes precedence.

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
| GET    | `/repos`                   | List open repos (`id`, `path`, `branch`)         |
| POST   | `/repos`                   | Open a repo: `{"path": "/abs/path"}` → `{id, path}` (201 created, 200 already open) |
| DELETE | `/repos/:id`               | Close a repo (refcounted per open)               |
| GET    | `/repos/:id/status`        | Shared state: status, hunk counts, stash list, in-progress operation, error |
| GET    | `/repos/:id/diff?path=&staged=` | Diff; whole tree without `path`, staged side with `staged=true` |
| GET    | `/repos/:id/history?count=` | Commit history (`CommitInfo[]`, default 100, ISO dates) |
| GET    | `/repos/:id/commits/:hash/diff` | Diff introduced by one commit (404 on unknown hash; merge and `--allow-empty` commits are 200 with an empty diff, matching the CLI) |
| GET    | `/repos/:id/branches`      | Local branches (`name`, `current`, `tracking`)   |
| GET    | `/repos/:id/base-branches` | Candidate compare bases (remote branches in recent history) |
| GET    | `/repos/:id/compare/base`  | Effective compare base: `{base}` (persisted choice or discovered default, null when none) |
| PUT    | `/repos/:id/compare/base`  | Persist the compare base: `{"branch": "origin/main"}` → `{base}`; the ref is validated first (400 on an unknown ref, nothing persisted) |
| GET    | `/repos/:id/compare?base=&uncommitted=` | Base-vs-HEAD `CompareDiff` (three-dot); base defaults to the effective base — a stale persisted base falls back to the discovered default, 422 when nothing usable resolves; an explicit unknown `base` is a 400; a base with no common history is a 422; `uncommitted=true` merges working-tree changes |
| GET    | `/repos/:id/tree?dir=&hidden=&ignored=` | One directory level (`name`, `path`, `type`), gitignored/hidden filtered by default (`hidden=true` / `ignored=true` include them, mirroring the TUI toggles), files annotated with `gitStatus` + `staged`, changed dirs with `hasChanges` (400 outside the repo root or on a file, 404 unknown dir) |
| GET    | `/repos/:id/file?path=`    | File content for display with flags: `{content, binary, truncated, tooLarge, size, totalLines}` — binary/oversized come back with empty content and the flag set, never prose; 400 for anything that is not a regular file (directory, FIFO, device) or resolves outside the repo root |
| GET    | `/repos/:id/files`         | All tracked + untracked (not ignored) paths: the fuzzy-finder source |
| GET    | `/repos/:id/events`        | SSE: `snapshot` on connect, then `state-change` events from the file watcher |

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

Examples over the default unix socket:

```bash
SOCK="$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock"

curl --unix-socket "$SOCK" http://localhost/health
curl --unix-socket "$SOCK" -X POST -d '{"path": "/home/me/repo"}' http://localhost/repos
curl --unix-socket "$SOCK" http://localhost/repos/<id>/status
curl --unix-socket "$SOCK" 'http://localhost/repos/<id>/diff?path=file.txt'
curl --unix-socket "$SOCK" -X POST -d '{"path": "file.txt"}' http://localhost/repos/<id>/stage
curl --unix-socket "$SOCK" -N http://localhost/repos/<id>/events
```

Forthcoming (the daemon split lands in slices): follow mode.
