# diffstalker (CLI) — developer notes

`diffstalker` is the terminal UI for interactive git staging and committing —
the package published to npm as `diffstalker`. It is a **pure client** of
`diffstalkerd`: it holds no in-process git and drives everything over the
daemon's REST + SSE API through `@diffstalker/client`.

> This is the developer-facing doc for the `packages/cli` workspace
> (`DEVELOPMENT.md`). The npm package page ships the repo-root `README.md`,
> copied in at pack time by `prepack` (as an untracked file) and removed by
> `postpack`. It is named `DEVELOPMENT.md` (not `README*`) so it never leaks
> into the published tarball.

## What it does

- Renders the diff/history/compare/explorer views and the commit flow with
  neo-blessed (24-bit color via a runtime patch).
- On launch, `DaemonLifecycle.ensureDaemon` resolves the daemon socket
  (`--socket`, then `$DIFFSTALKER_SOCKET`, then
  `$XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock`), attaches to a live
  `diffstalkerd`, or spawns one that outlives the TUI.
- One `RepoSession` per open repo is the client-side store: shared state is fed
  by the per-repo SSE stream and mutation envelopes; selection, history, and
  compare are pulled on demand. It reconnects on its own if the daemon drops
  (stable path-hashed repo ids survive a restart).
- Follow mode is client policy: the daemon watches the hook file and broadcasts
  `follow-change`; the CLI reacts (or not) via `FollowMode`.

The CLI never runs git and never stops the daemon; on exit it releases its
repos (`DELETE /repos`, refcounted).

## Running

From the repo root:

```bash
bun run dev                     # bun --watch (development)
bun run build && bun run start  # compiled

# Options
diffstalker --follow [FILE]     # follow a hook file for dynamic repo switching
diffstalker --socket PATH       # diffstalkerd socket to attach to or spawn on
diffstalker --debug             # log path changes to stderr
```

## Tests

```bash
cd packages/cli && bun test src/*.test.ts src/**/*.test.ts
```

CLI tests never touch a real daemon or spin up watchers: `RepoSession`/`App`
tests drive a fake `DiffstalkerClient`, and `DaemonLifecycle` tests use a
throwaway socket torn down with `fuser -k <socket>` (never `pkill diffstalkerd`
— that would kill your live daemon).

See the repo-root `CLAUDE.md` for architecture and `packages/daemon/README.md`
for the API the CLI consumes.
