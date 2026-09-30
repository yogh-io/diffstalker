/**
 * Lightweight logger writing to stderr. No framework, no dependency: one
 * line per event, then the error's detail indented under it.
 *
 *   2026-09-30T08:12:01.123Z warn  Failed to stage src/a.ts repo=/home/me/proj
 *     GitError: error: pathspec 'src/a.ts' did not match any file(s) known to git
 *
 * - `debug()` is gated by `setDebug(true)` (the --debug flag); it prints an
 *   error the way `warn()` does
 * - `warn()` and `error()` always write
 * - `warn(message, err)` prints the error and its cause chain, one line each
 *   (an operation failed and was handled; the name and message say why)
 * - `error(message, err)` prints the full stack of the error and of every
 *   cause (something unexpected happened; the stack says where)
 *
 * The optional context is appended as `key=value` pairs, for the facts a
 * message alone would leave out: which repo, which file, which route.
 */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/** Facts to append to a line as `key=value`. Undefined values are skipped. */
export type LogContext = Record<string, string | number | boolean | null | undefined>;

type Level = 'debug' | 'warn' | 'error';

function formatContext(context: LogContext | undefined): string {
  if (!context) return '';
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    const text = String(value);
    // Quote a value that would otherwise split into two pairs.
    pairs.push(`${key}=${/\s/.test(text) || text === '' ? JSON.stringify(text) : text}`);
  }
  return pairs.length === 0 ? '' : ` ${pairs.join(' ')}`;
}

/** `Name: message`, or the value itself when it is not an Error. */
function summarize(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * The error and its cause chain, one entry per line. With `stacks`, each
 * Error contributes its full stack instead of one summary line. Bounded
 * so a cause cycle cannot loop forever.
 */
export function describeError(err: unknown, opts: { stacks: boolean } = { stacks: true }): string {
  const lines: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth++) {
    const prefix = depth === 0 ? '' : 'caused by: ';
    const text = opts.stacks && current instanceof Error && current.stack ? current.stack : summarize(current);
    lines.push(prefix + text);
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join('\n');
}

function write(level: Level, message: string, context?: LogContext, detail?: string): void {
  // Padded so the messages line up across levels.
  const head = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${formatContext(context)}`;
  const body = detail ? `\n${detail.replace(/^/gm, '  ')}` : '';
  process.stderr.write(`${head}${body}\n`);
}

export function debug(message: string, err?: unknown, context?: LogContext): void {
  if (!debugEnabled) return;
  write('debug', message, context, err === undefined ? undefined : describeError(err, { stacks: false }));
}

export function warn(message: string, err?: unknown, context?: LogContext): void {
  write('warn', message, context, err === undefined ? undefined : describeError(err, { stacks: false }));
}

export function error(message: string, err?: unknown, context?: LogContext): void {
  write('error', message, context, err === undefined ? undefined : describeError(err));
}
