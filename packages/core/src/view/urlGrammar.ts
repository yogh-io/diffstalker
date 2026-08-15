/**
 * The web UI's URL grammar, as pure functions — the ONE copy of it.
 *
 *   /<view>/<repo-segments…>[?base=…][&at=…]
 *
 * The web client reads these URLs (useUrlSync) and `diffstalker link`
 * writes them, and the two must agree byte for byte: a link that encodes a
 * path differently than the parser decodes it does not error, it silently
 * lands somewhere else (a non-view-first path names no place at all, and an
 * `at` that does not match anything leaves the view aimed at nothing). So
 * the sentinel, the segment encoding and the query encoding live here, and
 * neither side gets its own copy.
 *
 * See useUrlSync's header for what the grammar MEANS — which anchor belongs
 * to which view, and how history entries are minted. This module is only
 * the encoding.
 */

/** The closed set of views a URL's first segment may name. */
export const VIEW_NAMES = ['changes', 'journal', 'history', 'compare', 'explorer'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export function isViewName(value: unknown): value is ViewName {
  return typeof value === 'string' && (VIEW_NAMES as readonly string[]).includes(value);
}

/** Segment 1 when the repo path is relative to the daemon's $HOME. */
export const HOME_SENTINEL = '~';

/**
 * decodeURIComponent, but a malformed escape (`%zz` — hand-typed, or a
 * mangled paste) yields the raw text instead of throwing. The address bar
 * is untrusted input; a URIError here would take the whole app down at
 * startup.
 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Query value encoding: `/` and `:` stay readable, everything else escapes. */
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).split('%2F').join('/').split('%3A').join(':');
}

/**
 * Read a query string without URLSearchParams, which turns a `+` in a
 * filename into a space. Splits on `&` and the FIRST `=`.
 */
export function readQuery(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? '' : part.slice(eq + 1);
    out.set(safeDecode(key), safeDecode(value));
  }
  return out;
}

/** A repo named by a URL: home-relative, or an absolute path. */
export interface UrlRepo {
  homeRelative: boolean;
  /** Path with no leading slash — under $HOME, or from the filesystem root. */
  path: string;
}

export interface UrlState {
  repo: UrlRepo | null;
  view: ViewName | null;
  /** The view's anchor: stack key, hash, or path. */
  at: string | null;
  /** Compare only: the explicitly picked base branch. */
  base: string | null;
}

export const EMPTY_URL_STATE: UrlState = { repo: null, view: null, at: null, base: null };

/**
 * Parse a location into the place it names. Anything that is not
 * view-first — `/`, a stale repo-first link from the old grammar, junk —
 * names no place at all.
 */
export function parseUrl(pathname: string, search: string = ''): UrlState {
  const raw = pathname.split('/').filter(Boolean);
  if (raw.length === 0 || !isViewName(raw[0])) return EMPTY_URL_STATE;
  const view = raw[0];
  const rest = raw.slice(1);
  const query = readQuery(search);
  const at = query.get('at') ?? null;
  const base = query.get('base') ?? null;
  if (rest.length === 0) return { repo: null, view, at, base };
  // The sentinel test runs on the RAW segment: a directory named `~` is
  // written `%7E` and must not be read as "under $HOME".
  const homeRelative = rest[0] === HOME_SENTINEL;
  const segs = (homeRelative ? rest.slice(1) : rest).map(safeDecode);
  return { repo: { homeRelative, path: segs.join('/') }, view, at, base };
}

/**
 * Absolute repo path -> URL segments, `~`-prefixed when under $HOME.
 *
 * A segment that IS the sentinel is written `%7E` by hand: `~` is an
 * unreserved character, so encodeURIComponent passes it through untouched,
 * and a repo at `/~/x` would otherwise write `/~/x` and read back as
 * "under $HOME" — a different repo entirely. Only the whole-segment case
 * can collide; the sentinel test compares a raw segment for equality, so a
 * `~` inside a longer name is already harmless.
 */
export function repoSegments(abs: string, home: string | null): string[] {
  const underHome = home !== null && (abs === home || abs.startsWith(home + '/'));
  const rel = underHome ? abs.slice(home.length) : abs;
  const segs = rel
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg === HOME_SENTINEL ? '%7E' : encodeURIComponent(seg)));
  return underHome ? [HOME_SENTINEL, ...segs] : segs;
}

/** One place, in the terms the URL records it. */
export interface UrlPlace {
  view: ViewName;
  /** Absolute worktree root, or null for "no repo open" (`/`). */
  repoPath: string | null;
  /** The daemon's $HOME, or null to keep paths absolute. */
  home?: string | null;
  at?: string | null;
  /** Compare only, and only when explicitly picked. */
  base?: string | null;
}

/**
 * Build the path+search a place is addressed by. Query order is
 * `base` then `at`, matching what the web writes, so a link and the URL
 * the app rewrites after landing on it are identical (an identical write
 * writes nothing, which keeps a shared link out of the Back stack).
 */
export function buildUrlPath(place: UrlPlace): string {
  if (place.repoPath === null) return '/';
  const query: string[] = [];
  if (place.base !== null && place.base !== undefined) {
    query.push(`base=${encodeQueryValue(place.base)}`);
  }
  if (place.at !== null && place.at !== undefined) {
    query.push(`at=${encodeQueryValue(place.at)}`);
  }
  const path = '/' + [place.view, ...repoSegments(place.repoPath, place.home ?? null)].join('/');
  return query.length === 0 ? path : `${path}?${query.join('&')}`;
}
