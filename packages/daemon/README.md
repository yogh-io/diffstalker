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

| Method | Path                       | What                                             |
| ------ | -------------------------- | ------------------------------------------------ |
| GET    | `/health`                  | `{ok, ready}`                                    |
| GET    | `/repos`                   | List open repos (`id`, `path`, `branch`)         |
| POST   | `/repos`                   | Open a repo: `{"path": "/abs/path"}` → `{id, path}` (201 created, 200 already open) |
| DELETE | `/repos/:id`               | Close a repo (refcounted per open)               |
| GET    | `/repos/:id/status`        | Shared state: status, hunk counts, error         |
| GET    | `/repos/:id/diff?path=&staged=` | Diff; whole tree without `path`, staged side with `staged=true` |
| POST   | `/repos/:id/stage`         | Stage a file: `{"path": "file.txt"}` → refreshed shared state |
| POST   | `/repos/:id/unstage`       | Unstage a file: same shape                       |
| GET    | `/repos/:id/events`        | SSE: `snapshot` on connect, then `state-change` events from the file watcher |

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

Forthcoming (the daemon split lands in slices): history, compare, explorer,
remote operations, follow mode, and hunk-level staging endpoints.
