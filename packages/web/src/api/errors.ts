/**
 * Error taxonomy for the browser transport, mirroring @diffstalker/client:
 * a DaemonError means the daemon was reached and answered with a non-2xx
 * HTTP status; anything else (fetch rejection, dropped body read, SSE
 * failure) is a connection error and routes into the reconnect flow.
 */

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

/**
 * True for a transport/connection loss — a rejected fetch, a dropped SSE
 * stream, a body read that died mid-flight — as opposed to a DaemonError,
 * which means the daemon answered. Stores use this to route connection
 * loss into the reconnect state (never an error banner) while genuine
 * HTTP failures keep their own handling.
 */
export function isConnectionError(err: unknown): boolean {
  return !(err instanceof DaemonError);
}
