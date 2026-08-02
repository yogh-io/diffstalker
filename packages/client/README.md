# @diffstalker/client

A typed REST + SSE client for `diffstalkerd`. Private (not published); consumed
by the `diffstalker` CLI today, and by a web client later.

It wraps the daemon's HTTP surface so callers work with rich types instead of
raw JSON: one method per endpoint, a `subscribe` helper for the per-repo and
daemon-scope SSE streams, and decoders that turn wire JSON (ISO dates, plain
objects) back into the same `@diffstalker/core` types the daemon serializes.

## Layout

```
src/index.ts      # Public exports: DiffstalkerClient, wire types, isConnectionError
src/client.ts     # DiffstalkerClient — typed methods for every endpoint + subscribe
src/transport.ts  # http-over-unix-socket / TCP fetch + SSE stream reader
src/wire.ts       # Wire types + decoders
```

## Consuming

Import over the workspace's subpath (bun resolves `./src` in dev, `./dist`
after a build):

```ts
import { DiffstalkerClient, isConnectionError } from '@diffstalker/client';

const client = new DiffstalkerClient({ socketPath: '/run/.../diffstalkerd.sock' });
const { id } = await client.openRepo('/abs/path/to/repo');
const state = await client.status(id);

const sub = client.subscribeRepo(id);
sub.on('snapshot', (s) => { /* initial state on connect */ });
sub.on('state-change', (s) => { /* live updates */ });
// sub.close() to stop.

// isConnectionError(err) distinguishes a dropped daemon from a real failure,
// so clients can show a calm "reconnecting" line instead of raw ENOENT.
```

Mutations resolve to the daemon's `{state, result?}` envelope; the client
applies the decoded `state` for you.

## Build & test

```bash
cd packages/client
bun run build
bun run test
```

See `packages/daemon/README.md` for the endpoint reference this client mirrors.
