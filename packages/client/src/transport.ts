/**
 * HTTP transport for the diffstalkerd client: a typed JSON request helper
 * and an incremental SSE reader, both over node:http against a unix socket
 * path or a TCP host/port. No dependencies beyond node builtins.
 */

import * as http from 'node:http';

/** Where the daemon listens: a unix socket path, or TCP host/port. */
export type TransportTarget = { socketPath: string } | { host: string; port: number };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * A non-2xx response from the daemon: carries the HTTP status and the
 * daemon's {error} message (or a generic one when the body had none).
 */
export class DaemonError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
  }
}

function connectionOptions(target: TransportTarget): http.RequestOptions {
  return 'socketPath' in target
    ? { socketPath: target.socketPath }
    : { host: target.host, port: target.port };
}

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

/** Handlers for one SSE connection. */
export interface SseHandlers {
  /** A named event arrived (comment/ping blocks are filtered out). */
  onEvent: (event: string, data: string) => void;
  /** The stream ended server-side or dropped. Never fires after close(). */
  onClose: () => void;
  /** Connection or protocol failure. Never fires after close(). */
  onError: (err: Error) => void;
}

/**
 * One live SSE connection: parses the byte stream incrementally into named
 * events (`event:` / `data:` lines, blank-line separated, comment blocks
 * skipped). close() destroys the underlying socket; no callback fires
 * afterwards, so a closed connection cannot leak events or errors.
 */
export class SseConnection {
  private request: http.ClientRequest;
  private closed = false;
  private buffer = '';

  constructor(target: TransportTarget, path: string, handlers: SseHandlers) {
    this.request = http.request(
      {
        ...connectionOptions(target),
        method: 'GET',
        path,
        headers: { accept: 'text/event-stream' },
      },
      (res) => this.onResponse(res, handlers)
    );
    this.request.on('error', (err) => {
      if (!this.closed) {
        this.closed = true;
        handlers.onError(err);
      }
    });
    this.request.end();
  }

  private onResponse(res: http.IncomingMessage, handlers: SseHandlers): void {
    if (res.statusCode !== 200) {
      this.failFromResponse(res, handlers);
      return;
    }
    res.setEncoding('utf-8');
    res.on('data', (chunk: string) => {
      if (!this.closed) this.feed(chunk, handlers);
    });
    res.on('end', () => {
      if (!this.closed) {
        this.closed = true;
        handlers.onClose();
      }
    });
  }

  /** Non-200 on connect: read the {error} body and surface a DaemonError. */
  private failFromResponse(res: http.IncomingMessage, handlers: SseHandlers): void {
    const status = res.statusCode ?? 0;
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => {
      if (this.closed) return;
      this.closed = true;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        // Non-JSON error body: the generic message below covers it.
      }
      handlers.onError(new DaemonError(status, errorMessage(parsed, status)));
    });
  }

  private feed(chunk: string, handlers: SseHandlers): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);

      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
        // Anything else (": ping" comments) is ignored.
      }
      if (event || data) {
        handlers.onEvent(event, data);
        if (this.closed) return; // A handler may have closed us mid-buffer.
      }
      end = this.buffer.indexOf('\n\n');
    }
  }

  /** Tear the connection down; no handler fires after this. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.request.destroy();
  }
}

/**
 * Typed JSON requests + SSE connections against one daemon endpoint.
 * Non-2xx responses reject with a DaemonError carrying the HTTP status and
 * the daemon's {error} message.
 */
export class Transport {
  constructor(private target: TransportTarget) {}

  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          ...connectionOptions(this.target),
          method,
          path,
          headers: {
            accept: 'application/json',
            ...(payload === null
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const raw = Buffer.concat(chunks).toString('utf-8');
            let parsed: unknown = null;
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw);
              } catch {
                reject(
                  new DaemonError(
                    status,
                    `Daemon sent invalid JSON (HTTP ${status}): ${raw.slice(0, 200)}`
                  )
                );
                return;
              }
            }
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
            } else {
              reject(new DaemonError(status, errorMessage(parsed, status)));
            }
          });
        }
      );
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  /** Open a long-lived SSE connection to an endpoint. */
  openSse(path: string, handlers: SseHandlers): SseConnection {
    return new SseConnection(this.target, path, handlers);
  }
}
