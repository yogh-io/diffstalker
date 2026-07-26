# Security Policy

## Threat model

diffstalker is a **local developer tool**. The `diffstalkerd` daemon exposes
your git repositories (file contents, history, diffs, and — from the terminal
UI — staging and git operations) over a REST + SSE API. It has **no
authentication**. Its security rests entirely on being reachable only by you:

- **By default the daemon binds an owner-only unix socket** (directory `0700`,
  socket `0600`). No network port is opened. This is the safe, recommended mode
  and the one the terminal UI uses.
- **The web UI needs a TCP port** (`diffstalkerd --port N`). The port is bound
  to `127.0.0.1` (loopback) unless you override it. While it runs, the daemon
  applies a loopback origin guard (a `Host` allow-list and cross-site request
  blocking) so a web page you visit in another tab cannot drive it or read your
  code via CSRF or DNS rebinding.
- **Do not pass `--host` to bind a routable interface.** That exposes an
  unauthenticated service — anyone who can reach the address can read your
  source and run git operations. The origin guard does not apply off loopback,
  and the daemon prints a warning if you do this. There is no supported way to
  expose diffstalkerd to a network safely today.

In short: **run it on localhost**. Treat the machine's own trust boundary as
the security boundary.

## Supported versions

diffstalker is pre-1.0. Security fixes land on the latest published version
(`diffstalker` and `diffstalkerd` are released in lockstep). Please run the
latest release.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

- Use GitHub's private vulnerability reporting:
  <https://github.com/yogh-io/diffstalker/security/advisories/new>

Include what you found, how to reproduce it, and the impact. We aim to
acknowledge reports promptly and will credit reporters who want it once a fix
is released.
