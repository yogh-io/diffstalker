/**
 * The single copy of the blob/media URL shape.
 *
 * The web builds these strings to put in an `<img src>`; the daemon routes
 * answer them; daemon tests assert against them. One module so the three can
 * never drift — a mismatch here is a broken image, or worse, a request the
 * route guards were not written for.
 *
 * Pure and import-free on purpose: it is bundled into the browser, so it may
 * not reach for node:path, node:url or anything else with a runtime.
 *
 * Every caller-supplied segment and query value goes through
 * encodeURIComponent. Repo ids are hashes and paths come from git, but a path
 * legitimately contains spaces, `#`, `?`, `&`, `+` and non-ASCII, and any one
 * of those would otherwise cut the query short or smuggle in a parameter. This
 * is the encoding side only; rejecting `..`, `.git` and pathspec magic is the
 * daemon's job, on the decoded value.
 */

export type BlobSide = 'worktree' | 'index' | 'head';

export interface BlobRef {
  /** Repo-relative path, as git spells it. */
  path: string;
  side: BlobSide;
  /**
   * Cache key: the blob oid, or `${size}-${mtimeMs}` for the worktree side.
   * The route accepts it and ignores it — it exists to make the browser fetch
   * fresh bytes when the file changes, and is never a lookup input.
   */
  version?: string;
}

/** Bytes for one side of one file. Same-origin and relative: never absolute. */
export function blobUrl(repoId: string, ref: BlobRef): string {
  const query = `path=${encodeURIComponent(ref.path)}&side=${encodeURIComponent(ref.side)}`;
  const version = ref.version === undefined ? '' : `&v=${encodeURIComponent(ref.version)}`;
  return `/repos/${encodeURIComponent(repoId)}/blob?${query}${version}`;
}

/** JSON metadata for both sides of a changed file, renames resolved server-side. */
export function mediaUrl(repoId: string, path: string, staged: boolean): string {
  const query = `path=${encodeURIComponent(path)}&staged=${staged ? '1' : '0'}`;
  return `/repos/${encodeURIComponent(repoId)}/media?${query}`;
}
