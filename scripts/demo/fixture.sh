#!/usr/bin/env bash
# scripts/demo/fixture.sh — build the demo repo the video is recorded against.
#
# A real repo is the wrong subject for a demo: it leaks paths and private code,
# its diffs change under you, and its history is not shaped like the story. So
# the video gets its own repo, rebuilt identically every run.
#
# The subject is a small HTTP relay gaining a rate limiter on a feature branch:
# four commits against `main`, plus uncommitted work in two of the three
# categories (unstaged + untracked) so the Compare toggles have something to
# fold in. That last part is the whole point of the video — reviewing work that
# is not committed yet, which no forge can show you.
#
# Lives under /tmp so scripts/rmrf.sh may remove it. The UI's header shows only
# the repo's directory NAME, so the path never appears on camera.
#
# Usage: scripts/demo/fixture.sh [dir]     (default: /tmp/diffstalker-demo/relay)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO="${1:-/tmp/diffstalker-demo/relay}"

case "$(realpath -m -- "$REPO")" in
  /tmp/* | /var/tmp/*) ;;
  *) echo "fixture: refusing to build outside /tmp: $REPO" >&2; exit 1 ;;
esac

"$repo_root/scripts/rmrf.sh" "$REPO"
mkdir -p "$REPO/src" "$REPO/docs"
cd "$REPO"

git init -q -b main
git config user.name  "Ada Lovelace"
git config user.email "ada@example.com"
git config commit.gpgsign false

# Commit at a fixed offset from now, so the UI shows plausible relative times
# ("3 hours ago") instead of dates frozen in whenever this script was written.
commit_at() {
  local when="$1" msg="$2"
  local stamp; stamp="$(date -d "$when" --iso-8601=seconds)"
  GIT_AUTHOR_DATE="$stamp" GIT_COMMITTER_DATE="$stamp" git commit -q -m "$msg"
}

# ---------------------------------------------------------------- main

cat > package.json <<'EOF'
{
  "name": "relay",
  "version": "1.4.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch src/server.js",
    "test": "node --test"
  }
}
EOF

cat > src/config.ts <<'EOF'
export interface Config {
  /** Port the relay listens on. */
  port: number;
  /** Where requests are forwarded. */
  upstream: string;
  /** Give up on the upstream after this long. */
  timeoutMs: number;
}

export const config: Config = {
  port: 8080,
  upstream: 'http://127.0.0.1:9000',
  timeoutMs: 5_000,
};
EOF

cat > src/routes.ts <<'EOF'
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export const routes: Record<string, Handler> = {
  '/health': (_req, res) => json(res, 200, { ok: true }),

  '/version': (_req, res) => json(res, 200, { version: '1.4.0' }),
};

export function notFound(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 404, { error: 'no such route' });
}
EOF

cat > src/server.ts <<'EOF'
import { createServer } from 'node:http';
import { config } from './config.js';
import { notFound, routes } from './routes.js';

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  const handler = routes[path];
  if (handler === undefined) {
    notFound(req, res);
    return;
  }

  handler(req, res);
});

server.listen(config.port, () => {
  console.log(`relay listening on :${config.port} -> ${config.upstream}`);
});
EOF

cat > README.md <<'EOF'
# relay

A small HTTP relay. Forwards what it is given, answers `/health` itself.

```bash
npm run dev
```
EOF

git add -A
commit_at "3 days ago"  "Initial relay"

# ------------------------------------------------- feat/rate-limit

git checkout -q -b feat/rate-limit

cat > src/rateLimit.ts <<'EOF'
/**
 * A token bucket per client key.
 *
 * Every key gets `capacity` tokens, refilled at `refillPerSecond`. A request
 * spends one. Empty bucket means the caller is over budget.
 */
export interface BucketOptions {
  capacity: number;
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: BucketOptions) {}

  /** Spend a token for `key`. False when the bucket is empty. */
  take(key: string, now: number = Date.now()): boolean {
    const bucket = this.refill(key, now);
    if (bucket.tokens < 1) return false;

    bucket.tokens -= 1;
    return true;
  }

  private refill(key: string, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing === undefined) {
      const fresh = { tokens: this.options.capacity, lastRefill: now };
      this.buckets.set(key, fresh);
      return fresh;
    }

    const elapsed = (now - existing.lastRefill) / 1000;
    existing.tokens = Math.min(
      this.options.capacity,
      existing.tokens + elapsed * this.options.refillPerSecond
    );
    existing.lastRefill = now;
    return existing;
  }
}
EOF

git add -A
commit_at "5 hours ago" "Add a token bucket"

python3 - <<'EOF'
from pathlib import Path
p = Path('src/server.ts')
s = p.read_text()
s = s.replace(
    "import { notFound, routes } from './routes.js';",
    "import { RateLimiter } from './rateLimit.js';\nimport { notFound, routes } from './routes.js';\n\n"
    "const limiter = new RateLimiter({ capacity: 20, refillPerSecond: 5 });\n\n"
    "/** Client identity, for now: the socket address. */\n"
    "function clientKey(req: { socket: { remoteAddress?: string } }): string {\n"
    "  return req.socket.remoteAddress ?? 'unknown';\n"
    "}",
)
s = s.replace(
    "  const handler = routes[path];",
    "  if (!limiter.take(clientKey(req))) {\n"
    "    res.writeHead(429).end();\n"
    "    return;\n"
    "  }\n\n"
    "  const handler = routes[path];",
)
p.write_text(s)
EOF

git add -A
commit_at "4 hours ago" "Apply the limiter to every request"

python3 - <<'EOF'
from pathlib import Path

p = Path('src/rateLimit.ts')
s = p.read_text()
s = s.replace(
    "  /** Spend a token for `key`. False when the bucket is empty. */\n"
    "  take(key: string, now: number = Date.now()): boolean {\n"
    "    const bucket = this.refill(key, now);\n"
    "    if (bucket.tokens < 1) return false;\n\n"
    "    bucket.tokens -= 1;\n"
    "    return true;\n"
    "  }",
    "  /** Spend a token for `key`. False when the bucket is empty. */\n"
    "  take(key: string, now: number = Date.now()): boolean {\n"
    "    const bucket = this.refill(key, now);\n"
    "    if (bucket.tokens < 1) return false;\n\n"
    "    bucket.tokens -= 1;\n"
    "    return true;\n"
    "  }\n\n"
    "  /**\n"
    "   * Whole seconds until `key` has a token again. Zero when it has one now.\n"
    "   * This is what the 429 promises, so it rounds UP: telling a caller to\n"
    "   * retry a moment too early just earns them a second 429.\n"
    "   */\n"
    "  retryAfter(key: string, now: number = Date.now()): number {\n"
    "    const bucket = this.refill(key, now);\n"
    "    if (bucket.tokens >= 1) return 0;\n\n"
    "    const missing = 1 - bucket.tokens;\n"
    "    return Math.ceil(missing / this.options.refillPerSecond);\n"
    "  }",
)
p.write_text(s)

p = Path('src/routes.ts')
s = p.read_text()
s = s.replace(
    "export function notFound(_req: IncomingMessage, res: ServerResponse): void {\n"
    "  json(res, 404, { error: 'no such route' });\n"
    "}",
    "export function notFound(_req: IncomingMessage, res: ServerResponse): void {\n"
    "  json(res, 404, { error: 'no such route' });\n"
    "}\n\n"
    "/** Over budget. `Retry-After` is in seconds, per RFC 9110. */\n"
    "export function tooManyRequests(res: ServerResponse, retryAfter: number): void {\n"
    "  res.setHeader('retry-after', String(retryAfter));\n"
    "  json(res, 429, { error: 'rate limited', retryAfter });\n"
    "}",
)
p.write_text(s)

p = Path('src/server.ts')
s = p.read_text()
s = s.replace(
    "import { notFound, routes } from './routes.js';",
    "import { notFound, routes, tooManyRequests } from './routes.js';",
)
s = s.replace(
    "  if (!limiter.take(clientKey(req))) {\n"
    "    res.writeHead(429).end();\n"
    "    return;\n"
    "  }",
    "  const key = clientKey(req);\n"
    "  if (!limiter.take(key)) {\n"
    "    tooManyRequests(res, limiter.retryAfter(key));\n"
    "    return;\n"
    "  }",
)
p.write_text(s)
EOF

git add -A
commit_at "2 hours ago" "Answer 429 with Retry-After"

cat > src/rateLimit.test.ts <<'EOF'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from './rateLimit.js';

test('spends the bucket, then refuses', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 });

  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('a', 0), false);
});

test('refills over time, and never past capacity', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 });

  limiter.take('a', 0);
  limiter.take('a', 0);
  assert.equal(limiter.take('a', 1_000), true);
  assert.equal(limiter.take('a', 60_000), true);
  assert.equal(limiter.take('a', 60_000), true);
  assert.equal(limiter.take('a', 60_000), false);
});

test('keys do not share a bucket', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 });

  assert.equal(limiter.take('a', 0), true);
  assert.equal(limiter.take('b', 0), true);
});

test('retryAfter rounds up to the next whole token', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 2 });

  limiter.take('a', 0);
  assert.equal(limiter.retryAfter('a', 0), 1);
  assert.equal(limiter.retryAfter('a', 10_000), 0);
});
EOF

git add -A
commit_at "40 minutes ago" "Cover the refill edge cases"

# ------------------------------------- uncommitted: the differentiator

# Unstaged: the limits move out of the constructor call and into config.
python3 - <<'EOF'
from pathlib import Path
p = Path('src/config.ts')
s = p.read_text()
s = s.replace(
    "  /** Give up on the upstream after this long. */\n  timeoutMs: number;\n}",
    "  /** Give up on the upstream after this long. */\n  timeoutMs: number;\n"
    "  /** Requests a single client may burst before it is limited. */\n  burst: number;\n"
    "  /** Sustained requests per second, once the burst is spent. */\n  ratePerSecond: number;\n}",
)
s = s.replace(
    "  timeoutMs: 5_000,\n};",
    "  timeoutMs: 5_000,\n  burst: 20,\n  ratePerSecond: 5,\n};",
)
p.write_text(s)
EOF

# Untracked: the doc that explains the feature.
cat > docs/rate-limit.md <<'EOF'
# Rate limiting

Every client gets a token bucket: `burst` tokens, refilled at
`ratePerSecond`. One request spends one token.

An empty bucket answers `429` with a `Retry-After` header, in whole
seconds, rounded up — a caller told to retry too early just earns a
second `429`.

| setting | default | meaning |
| --- | --- | --- |
| `burst` | 20 | requests a client may fire at once |
| `ratePerSecond` | 5 | sustained rate once the burst is spent |

Clients are keyed by socket address today. Behind a proxy that is the
proxy, not the caller — `X-Forwarded-For` is the next step.
EOF

echo "$REPO"
