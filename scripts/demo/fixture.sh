#!/usr/bin/env bash
# scripts/demo/fixture.sh — build the demo repo the video is recorded against.
#
# A real repo is the wrong subject for a demo: it leaks paths and private code,
# its diffs change under you, and its history is not shaped like the story. So
# the video gets its own repo, rebuilt identically every run.
#
# The subject is a small HTTP relay that has just grown a rate limiter: `main`,
# and a `feat/rate-limit` branch holding ONE commit that touches three files.
#
# The working tree is left CLEAN, deliberately. The take opens on the Changes
# tab with nothing in it, and every change you see appear is written while the
# camera is running (see choreograph.ts) — which is the thing a screenshot
# cannot show and the reason the video exists.
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
mkdir -p "$REPO/src"
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
commit_at "3 days ago" "Initial relay"

# Give the fixture an origin. Compare discovers its base by scanning recent
# history for REMOTE-tracking refs (getCandidateBaseBranches skips anything
# without a `/`), so a repo with only local branches has no base at all and
# the view opens with nothing to compare against. A real project has an
# origin; the fixture should too. No network is ever touched — the remote URL
# is unreachable on purpose and only the ref matters.
git remote add origin https://example.invalid/relay.git
git update-ref refs/remotes/origin/main main

# ------------------------------------------------- feat/rate-limit
#
# ONE commit, three files. The final content is written directly rather than
# built up through intermediate commits: the video only ever shows this
# commit's diff, so the steps that would have led to it are just noise.

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

  /**
   * Whole seconds until `key` has a token again. Zero when it has one now.
   * This is what the 429 promises, so it rounds UP: telling a caller to
   * retry a moment too early just earns them a second 429.
   */
  retryAfter(key: string, now: number = Date.now()): number {
    const bucket = this.refill(key, now);
    if (bucket.tokens >= 1) return 0;

    const missing = 1 - bucket.tokens;
    return Math.ceil(missing / this.options.refillPerSecond);
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

/** Over budget. `Retry-After` is in seconds, per RFC 9110. */
export function tooManyRequests(res: ServerResponse, retryAfter: number): void {
  res.setHeader('retry-after', String(retryAfter));
  json(res, 429, { error: 'rate limited', retryAfter });
}
EOF

cat > src/server.ts <<'EOF'
import { createServer } from 'node:http';
import { config } from './config.js';
import { RateLimiter } from './rateLimit.js';
import { notFound, routes, tooManyRequests } from './routes.js';

const limiter = new RateLimiter({ capacity: 20, refillPerSecond: 5 });

/** Client identity, for now: the socket address. */
function clientKey(req: { socket: { remoteAddress?: string } }): string {
  return req.socket.remoteAddress ?? 'unknown';
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  const key = clientKey(req);
  if (!limiter.take(key)) {
    tooManyRequests(res, limiter.retryAfter(key));
    return;
  }

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

git add -A
commit_at "2 hours ago" "Add a token bucket"

# The working tree is left clean on purpose. The take writes into it.
echo "$REPO"
