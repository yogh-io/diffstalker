# Contributing to diffstalker

Thanks for your interest in diffstalker. This is a small project; issues and
pull requests are welcome.

## Reporting bugs and ideas

Open an issue at <https://github.com/yogh-io/diffstalker/issues>. For **security**
issues, do not open a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

diffstalker is a [Bun](https://bun.sh) workspace of five packages
(`core`, `daemon`, `client`, `cli`, `web`). See [CLAUDE.md](CLAUDE.md) for a
tour of the architecture.

```bash
bun install          # installs all workspace packages + activates the git hooks
bun run build        # tsc across every package (the only type-check gate)
bun run test         # full suite (core + cli + daemon + client + web)
bun run lint         # ESLint + dependency-cruiser
bun run dev          # run the CLI against a dev daemon
bun run serve        # run the web UI + a dev daemon at http://localhost:17337
```

Requires Node `>= 20.10` and a recent Bun.

## Before you open a pull request

- `bun run build`, `bun run test`, and `bun run lint` must all pass. A
  pre-commit hook runs `bun run lint` for you; a pre-push hook runs the full
  test suite. CI (`.github/workflows/ci.yml`) runs the same on every PR.
- Lint must be **0 errors**. A fixed set of `sonarjs/cognitive-complexity`
  warnings is expected (see CLAUDE.md); do not add new ones.
- Keep the change focused and match the style and comment density of the code
  around it. Add tests for new behavior — the project is test-heavy on purpose.
- When you add a user-facing feature, update `FEATURES.md`.

## Architecture guardrails

- The **CLI holds no git**: it is a pure client of the daemon over REST + SSE.
  `simple-git` and `chokidar` live only in `core`/`daemon`. A dependency-cruiser
  rule enforces this — `bun run deps` checks it.
- The daemon is **loopback-only and unauthenticated** by design. Do not add a
  way to bind a routable interface or weaken the origin guard
  (`packages/daemon/src/security.ts`) without a matching auth story. See
  [SECURITY.md](SECURITY.md).

## Releasing

Maintainers publish with `bun run release[:minor|:major]`, which is the single
source of version truth. See the Releasing section of [CLAUDE.md](CLAUDE.md).

## License

By contributing you agree that your contributions are licensed under the
project's [MIT license](LICENSE).
