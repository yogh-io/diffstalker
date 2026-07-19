/**
 * Minimal method+path router for the daemon's REST API.
 *
 * Supports `:param` path segments, query strings, and JSON bodies on
 * mutating methods. Handlers throw HttpError for expected failures; the
 * router turns any thrown error into a non-2xx `{error}` JSON response
 * with the right status code (the HTTP status is the success signal —
 * there is no `success` envelope).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
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

  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  private add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      let matched: { handler: RouteHandler; params: Record<string, string> } | null = null;
      for (const route of this.routes) {
        if (route.method !== method) continue;
        const params = matchRoute(route, segments);
        if (params) {
          matched = { handler: route.handler, params };
          break;
        }
      }
      if (!matched) {
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
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, status, { error: message });
    }
  }
}
