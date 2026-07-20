/**
 * Static-file serving for the bundled web UI (SPA).
 *
 * The router consults this only for GET requests no API route matched, so
 * API routes always win. Paths under the API prefixes (/health, /repos,
 * /events, /follow) never fall back to the SPA either — an unknown
 * /repos/... path stays a JSON 404, exactly as before.
 *
 * Everything else: a path that maps to a real file under webRoot is served
 * with its content type; anything else gets index.html (SPA fallback).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HttpError } from './router.js';

/** First path segments owned by the REST/SSE API; never SPA routes. */
const API_PREFIXES = new Set(['health', 'repos', 'events', 'follow']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** index.html must revalidate (it names the hashed assets)… */
const NO_CACHE = 'no-cache';
/** …while the hashed /assets/* files are immutable by construction. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
) => Promise<void>;

async function serveFile(
  res: ServerResponse,
  filePath: string,
  cacheControl: string
): Promise<void> {
  let data: Buffer;
  try {
    data = await fs.promises.readFile(filePath);
  } catch {
    // webRoot exists but the file does not (e.g. no index.html): a plain 404.
    throw new HttpError(404, `Not found: ${path.basename(filePath)}`);
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    'content-length': data.length,
  });
  res.end(data);
}

/**
 * Build the router fallback serving the built web UI from `webRoot`.
 * Throws HttpError for expected failures (the router turns them into
 * `{error}` JSON, same as the API routes).
 */
export function createStaticHandler(webRoot: string): StaticHandler {
  const root = path.resolve(webRoot);

  return async (_req, res, pathname) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, `Malformed percent-encoding in path: ${pathname}`);
    }
    if (decoded.includes('\0')) {
      throw new HttpError(400, 'Invalid path');
    }

    const segments = decoded.split('/').filter(Boolean);
    if (segments.length > 0 && API_PREFIXES.has(segments[0])) {
      // API territory: an unmatched path here is an unknown API route,
      // not an SPA route.
      throw new HttpError(404, `Unknown route: GET ${pathname}`);
    }

    // Containment check: the resolved target must stay inside webRoot
    // (decoded `..` segments survive URL normalization and land here).
    const target = segments.length > 0 ? path.resolve(root, segments.join('/')) : root;
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new HttpError(403, 'Forbidden');
    }

    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat?.isFile()) {
      await serveFile(res, target, segments[0] === 'assets' ? IMMUTABLE : NO_CACHE);
      return;
    }

    // SPA fallback: /, client-side routes, and anything else that is not
    // a real file all get index.html.
    await serveFile(res, path.join(root, 'index.html'), NO_CACHE);
  };
}
