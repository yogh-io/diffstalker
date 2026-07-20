/**
 * Browser transport for diffstalkerd: typed JSON requests over fetch and
 * SSE subscriptions over native EventSource, both against same-origin
 * RELATIVE URLs (the daemon serves the SPA, so no host/CORS involved).
 *
 * This deliberately does NOT reuse @diffstalker/client's transport — that
 * one is Node-only (node:http, unix sockets, a hand-rolled SSE parser).
 * Only the method surface and error taxonomy are mirrored.
 */

import { DaemonError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The daemon's {error} body message, when the payload carries one. */
function errorMessage(parsed: unknown, status: number): string {
  if (typeof parsed === 'object' && parsed !== null) {
    const message = (parsed as Record<string, unknown>).error;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return `Daemon request failed with HTTP ${status}`;
}

/** Wrap a network-level failure so it stays a plain (connection) Error. */
function connectionFailure(stage: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`daemon unreachable (${stage}): ${detail}`);
}

/**
 * One JSON request against the daemon. Non-2xx responses reject with a
 * DaemonError carrying the HTTP status and the daemon's {error} message;
 * any network failure rejects with a plain Error (a connection error).
 */
export async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? null : JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === null ? {} : { body: payload }),
    });
  } catch (err) {
    throw connectionFailure('request', err);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (err) {
    throw connectionFailure('response body', err);
  }

  const status = response.status;
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DaemonError(
        status,
        `Daemon sent invalid JSON (HTTP ${status}): ${raw.slice(0, 200)}`
      );
    }
  }
  if (status >= 200 && status < 300) {
    return parsed as T;
  }
  throw new DaemonError(status, errorMessage(parsed, status));
}

/** Handlers for one SSE subscription. */
export interface SubscribeHandlers {
  /** A named event arrived, payload already JSON-parsed (null when empty). */
  onEvent: (event: string, payload: unknown) => void;
  /** The connection (re)opened. EventSource retries on its own. */
  onOpen?: () => void;
  /** The connection dropped or an event payload was invalid JSON. */
  onError?: () => void;
}

/** A live SSE subscription; close() silences it permanently. */
export interface SseHandle {
  close(): void;
}

/**
 * Subscribe to a daemon SSE endpoint with native EventSource. A listener
 * is registered per named event (EventSource only dispatches events it
 * has listeners for; `: ping` comments are ignored by the browser). The
 * browser auto-reconnects dropped streams — onError fires per drop and
 * onOpen per (re)connect; callers that manage their own retry (the repo
 * store) close() the handle instead.
 */
export function subscribe(
  path: string,
  events: readonly string[],
  handlers: SubscribeHandlers
): SseHandle {
  const source = new EventSource(path);
  let closed = false;

  for (const name of events) {
    source.addEventListener(name, (raw) => {
      if (closed) return;
      const data = (raw as MessageEvent<string>).data;
      let payload: unknown = null;
      if (typeof data === 'string' && data.length > 0) {
        try {
          payload = JSON.parse(data);
        } catch {
          handlers.onError?.();
          return;
        }
      }
      handlers.onEvent(name, payload);
    });
  }

  source.onopen = () => {
    if (!closed) handlers.onOpen?.();
  };
  source.onerror = () => {
    if (!closed) handlers.onError?.();
  };

  return {
    close(): void {
      if (closed) return;
      closed = true;
      source.close();
    },
  };
}
