# Logs

Where to look when something went wrong, and what a line means.

## Where the logs are

The daemon (`diffstalkerd`) writes every log line to stderr. Where stderr
goes depends on how the daemon was started:

- **systemd user unit** (`packaging/systemd/diffstalkerd.service`): the journal.

  ```bash
  journalctl --user -u diffstalkerd -f          # follow live
  journalctl --user -u diffstalkerd --since -1h # the last hour
  journalctl --user -u diffstalkerd -p warning  # warn and error lines only
  ```

- **Spawned by the terminal UI** (no daemon was running when `diffstalker`
  started): a log file, since the daemon outlives the TUI and has no
  terminal of its own.

  ```
  $XDG_STATE_HOME/diffstalker/diffstalkerd.log     # ~/.local/state/diffstalker/diffstalkerd.log
  ```

  When the file is over about 1 MB at the next spawn, it is renamed to
  `diffstalkerd.log.1` (replacing the previous one) and a fresh file is
  started, so there is never more than one old file. If the daemon did
  not come up, the CLI's error names the file.

- **Started by hand** (`diffstalkerd --socket ...`, `bun packages/daemon/src/index.ts`):
  the terminal it was started in.

The **web UI** logs to the browser console (devtools). Every error line
the UI shows (the header line, a banner, a "failed" badge) has a
`console.error` behind it with the operation, the HTTP status, the
daemon's own message and the thrown error. A lost daemon connection is
one `console.warn`. There is no client-to-daemon error channel: the daemon
logs its own side, so a bug report needs both.

The **terminal UI** logs to its own stderr, which is the screen; it keeps
that to a minimum. Its failures are the daemon's, so look there.

## Line shape

```
2026-09-30T08:12:01.123Z warn  Failed to stage src/a.ts repo=/home/me/proj file=src/a.ts
  GitError: error: pathspec 'src/a.ts' did not match any file(s) known to git
```

An ISO timestamp, the level, the message, then `key=value` facts (which
repo, which file, which route) and, indented under it, the error. The
daemon's startup and shutdown lines (`diffstalkerd listening on ...`,
`Received SIGTERM, shutting down`) have no timestamp or level: they are
status, not events.

## Levels

- **error** — something unexpected happened: a 500 (a route threw
  something it did not describe), an uncaught exception or unhandled
  rejection (the daemon exits after it), a settings file that exists but
  cannot be read, a bug in a path that is written never to throw. The
  full stack is printed, and the stack of every `cause` under it.
- **warn** — an operation failed and was handled, and this is the trace of
  it: a git command that git refused (a rejected push, a stage of a file
  git does not know, a refresh that hit `index.lock`), a request answered
  with an error the route made from a real failure (its `cause` is
  printed), a watcher error, a watch directory that could not be scanned,
  an invalid settings file, a symbol worker that died. The error and its
  cause chain are printed as one summary line each, no stack.
- **debug** — only with `--debug`: every request refused with a plain 4xx
  (unknown repo, bad parameter), every follow target that was not a repo,
  a HEAD that could not be read (an unborn branch), a version lookup that
  failed offline.

Anything quiet is meant to be: a probe that expects to miss (a stat on a
file that may not exist, `git check-ignore` exiting 1 for "not ignored",
a race the code already handles) says nothing, and the comment at the
catch says why.

## Turning on debug

- By hand: `diffstalkerd --debug ...`
- Under systemd: a drop-in that adds the flag.

  ```bash
  systemctl --user edit diffstalkerd
  ```

  ```ini
  [Service]
  ExecStart=
  ExecStart=/usr/bin/diffstalkerd --port 7337 --debug
  ```

- The terminal UI's own `--debug` (or `debug: true` in its config) only
  affects the TUI's lines, not the daemon it attaches to.
