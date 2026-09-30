/**
 * The devtools trace behind a failure the UI shows as one short line.
 *
 * A header line or a banner says WHAT failed in a few words; the reason
 * (the HTTP status, the daemon's own message, the thrown error with its
 * stack) has nowhere to go on screen. It goes to the browser console, so
 * a bug report can carry it. There is no client-to-daemon error channel
 * on purpose: the daemon logs its own side.
 */

import { DaemonError, errorMessage, isConnectionError } from '../api/errors';

/** Log a failure with the operation, the status (when the daemon answered), the message and the error. */
export function logFailure(operation: string, err: unknown, detail: Record<string, unknown> = {}): void {
  console.error(`diffstalker: ${operation} failed`, {
    status: err instanceof DaemonError ? err.status : null,
    message: errorMessage(err),
    ...detail,
    error: err,
  });
}

/**
 * Same, but only when the daemon answered and refused. A connection loss
 * is reported once by the store that enters the reconnect state, and
 * every call that failed because of it would only repeat that.
 */
export function logDaemonRefusal(
  operation: string,
  err: unknown,
  detail: Record<string, unknown> = {}
): void {
  if (isConnectionError(err)) return;
  logFailure(operation, err, detail);
}
