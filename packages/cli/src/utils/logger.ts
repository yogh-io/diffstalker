/**
 * Lightweight structured logger writing to stderr.
 *
 * - `debug()` is gated by `setDebug(true)` (set from the --debug flag)
 * - `warn()` and `error()` always write to stderr
 */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function debug(message: string): void {
  if (debugEnabled) {
    process.stderr.write(`[diffstalker ${timestamp()}] ${message}\n`);
  }
}

export function warn(message: string): void {
  process.stderr.write(`[diffstalker warn] ${message}\n`);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err) return String(err);
  return '';
}

export function error(message: string, err?: unknown): void {
  const detail = err ? `: ${formatError(err)}` : '';
  process.stderr.write(`[diffstalker error] ${message}${detail}\n`);
}
