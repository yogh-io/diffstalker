/**
 * Version reporting: what this daemon is running, and what npm publishes.
 *
 * The running version comes from the daemon's own package.json (one level
 * up from this module, both in dist/ and in src/). The published version
 * comes from npm's dist-tags endpoint — the smallest registry response
 * that answers "what is latest" — fetched lazily (only when a client asks
 * GET /version) and cached, so an open web UI costs at most one registry
 * request per TTL.
 *
 * Either half can be unknown (unreadable manifest, offline, opt-out); the
 * state says so with nulls and status 'unknown' instead of guessing, and
 * clients hide the indicator rather than claim a match.
 */

import * as fs from 'node:fs';

/** How the running version relates to the latest published one. */
export type VersionStatus = 'current' | 'outdated' | 'ahead' | 'unknown';

export interface VersionState {
  /** The running daemon's version. Null when its package.json is unreadable. */
  current: string | null;
  /** The latest version published to npm. Null when unknown (offline/opt-out). */
  latest: string | null;
  status: VersionStatus;
}

/** Reads the latest published version, or null when it cannot be known. */
export type LatestVersionFetcher = () => Promise<string | null>;

export interface VersionService {
  /** The current state, hitting the registry only when the cache is cold. */
  state(): Promise<VersionState>;
}

/** dist-tags only — a few bytes, versus the full packument. */
export const REGISTRY_DIST_TAGS_URL =
  'https://registry.npmjs.org/-/package/diffstalkerd/dist-tags';

export const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
/** A failed lookup is retried sooner than a good one is refreshed. */
export const FAILURE_TTL_MS = 5 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 5000;

/**
 * The daemon's own version, read once at import.
 *
 * A missing or malformed manifest is reported as null, not thrown: the
 * daemon's job is git state, and it must not fail to start because it
 * cannot introspect its own version.
 */
export function readCurrentVersion(): string | null {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Ask npm for the `latest` dist-tag of diffstalkerd. */
export async function fetchLatestFromNpm(): Promise<string | null> {
  const res = await fetch(REGISTRY_DIST_TAGS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { latest?: unknown };
  return typeof body.latest === 'string' ? body.latest : null;
}

/** Parse `x.y.z` (any prerelease/build suffix is ignored — we publish plain releases). */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(current: string | null, latest: string | null): VersionStatus {
  if (current === null || latest === null) return 'unknown';
  const running = parseVersion(current);
  const published = parseVersion(latest);
  if (!running || !published) return 'unknown';

  for (let i = 0; i < running.length; i++) {
    if (running[i] < published[i]) return 'outdated';
    if (running[i] > published[i]) return 'ahead';
  }
  return 'current';
}

/**
 * Build the /version service. `fetchLatest` is the seam tests replace (and
 * that --no-update-check stubs out); `current` is the running version.
 *
 * Caching is per daemon instance: a hit inside the TTL never touches the
 * network, and concurrent misses share one in-flight request.
 */
export function createVersionService(
  fetchLatest: LatestVersionFetcher = fetchLatestFromNpm,
  current: string | null = readCurrentVersion()
): VersionService {
  let cached: { value: string | null; expiresAt: number } | null = null;
  let pending: Promise<string | null> | null = null;

  function loadLatest(): Promise<string | null> {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value);
    if (pending) return pending;

    pending = fetchLatest()
      // A registry that is unreachable, slow, or answering nonsense is not
      // a daemon error — it just means the latest version is unknown.
      .catch(() => null)
      .then((value) => {
        const ttl = value === null ? FAILURE_TTL_MS : LATEST_TTL_MS;
        cached = { value, expiresAt: Date.now() + ttl };
        pending = null;
        return value;
      });
    return pending;
  }

  return {
    async state(): Promise<VersionState> {
      const latest = await loadLatest();
      return { current, latest, status: compareVersions(current, latest) };
    },
  };
}
