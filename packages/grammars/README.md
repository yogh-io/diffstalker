# diffstalkerd-grammars

Tree-sitter grammars and outline queries for `diffstalkerd`'s in-file symbol
search (`o` in the web UI).

**Opt-in.** `diffstalkerd` works without this package — outlines are simply
absent, and `GET /health` reports which extensions the running daemon can
actually outline so a client can say so rather than guess. Install it only if
you want outlines:

```
npm i -g diffstalkerd-grammars
```

On Arch, use the companion AUR package instead. `npm i -g` there installs into
`/usr`, which pacman does not own — see `diffstalker-git`'s PKGBUILD for why
that goes badly.

## What is here

| File | Source |
|---|---|
| `web-tree-sitter.wasm` | the tree-sitter runtime |
| `tree-sitter-typescript.wasm` | TypeScript, and Vue `<script>` blocks |
| `tree-sitter-javascript.wasm` | JavaScript |
| `tree-sitter-java.wasm` | Java |
| `queries/*.scm` | ours — what counts as a symbol |
| `checksums.json` | sha256 of every file, plus the runtime version |

The `.wasm` files are **not committed**. `bun run vendor` fetches them against
pinned versions and checksums; a mismatch writes nothing and fails, because a
grammar that drifts from its query does not error — it captures the wrong nodes
and produces confidently wrong labels.

## Adding a language

1. Pin the grammar package and its sha256 in `scripts/vendor.ts`.
2. Write `queries/<grammar>.scm`. One `@symbol.<kind>` and one `@name` per
   pattern; the extractor reads nothing else.
3. Map the extensions in `packages/core/src/symbols/languages.ts`.
4. Add golden fixtures to `packages/daemon/src/symbols/pool.test.ts`, and run
   the query over real files of that language before shipping it.
5. `bun run vendor` to refresh `checksums.json`.

No code changes are needed for steps 1, 2 and 5 — a language is data. But the
set is closed at the repo boundary: there is no runtime grammar loading and no
user-supplied wasm path, because follow mode opens repositories without anyone
clicking, and a repo-controlled grammar path would be arbitrary WebAssembly
executing on the daemon's origin.
