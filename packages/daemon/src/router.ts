/**
 * Minimal method+path router for the daemon's REST API.
 *
 * Supports `:param` path segments, query strings, and JSON bodies on
 * mutating methods. Handlers throw HttpError for expected failures; the
 * router turns any thrown error into a non-2xx `{error}` JSON response
 * with the right status code (the HTTP status is the success signal —
 * there is no `success` envelope).
 *
 * `sendBytes` is the one exception to "every response is JSON", and it
 * carries an invariant the error handling below cannot enforce: once
 * headers are out, `handle()` can only `res.end()` — it cannot turn a
 * late failure into an error response. So a route that writes bytes must
 * throw every HttpError it is ever going to throw BEFORE it calls
 * `sendBytes`, or a failure after the first write reaches the client as a
 * truncated 200 that the browser will happily try to decode.
 *
 * Only an HttpError's message reaches the client. Everything else is a
 * failure nobody wrote a message for, so its message is whatever threw it
 * — a git command line, an absolute path, an errno — and the daemon is
 * reachable from a browser. That detail goes to stderr, where it is what a
 * developer needs, and the client gets a status and nothing else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { error as logError } from '@diffstalker/core/utils/logger';
import { toWire } from './serialize.js';

const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

/**
 * Handles a GET request no route matched (static files / SPA fallback).
 * Runs inside the router's error handling: thrown HttpErrors become
 * `{error}` JSON responses like any route's.
 */
export type FallbackHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** Send a JSON response; payload is made wire-safe (Dates, Maps) first. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(toWire(payload));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Send a raw body — the only non-JSON writer in the API. Every HttpError
 * the route can raise must already have been thrown when this is called
 * (see the module comment).
 *
 * `content-length` comes from the body itself and is written last, so a
 * caller cannot hand in a length that disagrees with the bytes. The
 * content-type is NOT set here: the caller passes the exact type it
 * derived from the body's magic bytes, and nothing in this file may
 * guess one from a path or an extension.
 */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Uint8Array,
  headers: Record<string, string>
): void {
  res.writeHead(status, { ...headers, 'content-length': String(body.byteLength) });
  res.end(body);
}

function matchRoute(route: Route, segments: string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const pattern = route.segments[i];
    if (pattern.startsWith(':')) {
      try {
        params[pattern.slice(1)] = decodeURIComponent(segments[i]);
      } catch {
        // Malformed percent-encoding (e.g. %zz) is a client error, not a 500
        throw new HttpError(400, `Malformed percent-encoding in path: ${segments[i]}`);
      }
    } else if (pattern !== segments[i]) {
      return null;
    }
  }
  return params;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  private add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  private match(
    method: string,
    segments: string[]
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchRoute(route, segments);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    fallback?: FallbackHandler
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      const matched = this.match(method, segments);
      if (!matched) {
        // API routes always win: the fallback only ever sees requests no
        // route claimed, and only GETs (static files have no mutations).
        if (fallback && method === 'GET') {
          await fallback(req, res, url.pathname);
          return;
        }
        throw new HttpError(404, `Unknown route: ${method} ${url.pathname}`);
      }

      const body = await readJsonBody(req);
      await matched.handler({
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body,
      });
    } catch (err) {
      if (res.headersSent) {
        // Streaming responses (SSE) can't switch to a JSON error; just end.
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      // Not a failure any route described, so the message is the raw one from
      // whatever broke. It stays server-side (see the module comment).
      logError(`${req.method ?? 'GET'} ${req.url ?? '/'}`, err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
}
