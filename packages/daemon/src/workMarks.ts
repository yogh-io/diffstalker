/**
 * The Work page's marks: the only state that page keeps
 * (docs/work-page.md §5.3). Track moves an item to Work, dismiss hides it
 * while its fingerprint holds. Owned by the daemon so every tab agrees.
 *
 * Stored at `$XDG_STATE_HOME/diffstalker/work.json`, written atomically
 * like daemon.json. Every daemon of the user shares it (the dev daemon
 * too), so each read and each change starts from the file, not from
 * memory. A mangled file counts as empty instead of stopping the daemon.
 * Only the page knows which items still exist, so it names the stale keys
 * to drop (`prune`) and nothing is dropped here on its own.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { warn as logWarn, error as logError } from '@diffstalker/core/utils/logger';
import type { WorkMarkAction, WorkMarkRequest, WorkMarks } from '@diffstalker/core/types/work';
import { HttpError } from './router.js';

/** At most this many marks of each kind, and keys in one `prune`. */
export const MAX_MARKS = 2000;

const MAX_KEY_LENGTH = 4096;
const MAX_FINGERPRINT_LENGTH = 512;
const ACTIONS: readonly string[] = [
  'track',
  'dismiss',
  'drop',
  'undismiss',
] satisfies WorkMarkAction[];

type Tracked = Map<string, { at: number }>;
type Dismissed = Map<string, { fingerprint: string; at: number }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key holds a newline (`<root>\n<branch>`) but never a NUL. */
function isKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_KEY_LENGTH &&
    !value.includes('\0')
  );
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_FINGERPRINT_LENGTH;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The body as a request, or an HttpError(400). */
export function parseMarkRequest(body: unknown): WorkMarkRequest {
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON body with "key" and "action"');
  const { key, action, fingerprint, prune } = body;
  if (!isKey(key)) {
    throw new HttpError(
      400,
      `Invalid "key" (a string of 1 to ${MAX_KEY_LENGTH} characters, no NUL)`
    );
  }
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    throw new HttpError(400, 'Invalid "action" (track, dismiss, drop or undismiss)');
  }
  if (fingerprint !== undefined && !isFingerprint(fingerprint)) {
    throw new HttpError(
      400,
      `Invalid "fingerprint" (a string of at most ${MAX_FINGERPRINT_LENGTH} characters)`
    );
  }
  if (action === 'dismiss' && fingerprint === undefined) {
    throw new HttpError(400, '"dismiss" needs a "fingerprint"');
  }
  if (
    prune !== undefined &&
    (!Array.isArray(prune) || prune.length > MAX_MARKS || !prune.every(isKey))
  ) {
    throw new HttpError(400, `Invalid "prune" (at most ${MAX_MARKS} keys)`);
  }
  const request: WorkMarkRequest = { key, action: action as WorkMarkAction };
  if (fingerprint !== undefined) request.fingerprint = fingerprint;
  if (prune !== undefined) request.prune = prune as string[];
  return request;
}

/** The entries of a stored map that are well-shaped, at most MAX_MARKS. */
function wellShaped<T>(
  raw: unknown,
  read: (value: Record<string, unknown>) => T | null
): Map<string, T> {
  const kept = new Map<string, T>();
  if (!isRecord(raw)) return kept;
  for (const [key, value] of Object.entries(raw)) {
    if (kept.size >= MAX_MARKS) break;
    const entry = isKey(key) && isRecord(value) ? read(value) : null;
    if (entry !== null) kept.set(key, entry);
  }
  return kept;
}

/** Believe only well-shaped entries. */
function sanitize(raw: unknown): { tracked: Tracked; dismissed: Dismissed } {
  const file = isRecord(raw) ? raw : {};
  return {
    tracked: wellShaped(file.tracked, (value) => (isTime(value.at) ? { at: value.at } : null)),
    dismissed: wellShaped(file.dismissed, (value) =>
      isFingerprint(value.fingerprint) && isTime(value.at)
        ? { fingerprint: value.fingerprint, at: value.at }
        : null
    ),
  };
}

/** The file's JSON; `{}` when it is missing, or unreadable or not JSON (logged). */
function readMarksFile(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError('Cannot read the work marks file; using none', err, { file });
    }
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    logWarn('Ignoring the work marks file: not valid JSON', err, { file });
    return {};
  }
}

function toMarks(tracked: Tracked, dismissed: Dismissed): WorkMarks {
  // fromEntries makes own properties, so a key like `__proto__` stays a key.
  return { tracked: Object.fromEntries(tracked), dismissed: Object.fromEntries(dismissed) };
}

export class WorkMarksStore {
  private tracked: Tracked = new Map();
  private dismissed: Dismissed = new Map();

  /** `file` null means memory only. */
  constructor(private readonly file: string | null) {}

  get marks(): WorkMarks {
    return toMarks(this.tracked, this.dismissed);
  }

  /**
   * Read the file, which every daemon of this user shares. A missing file is
   * no marks; a bad one logs and counts as none.
   */
  load(): WorkMarks {
    if (this.file === null) return this.marks;
    ({ tracked: this.tracked, dismissed: this.dismissed } = sanitize(readMarksFile(this.file)));
    return this.marks;
  }

  /** Apply one request to the file's marks and persist. Throws if the write fails. */
  apply(request: WorkMarkRequest, now: number): WorkMarks {
    // Re-read: another daemon may have written since, and its marks must stay.
    this.load();
    const tracked: Tracked = new Map(this.tracked);
    const dismissed: Dismissed = new Map(this.dismissed);
    for (const key of request.prune ?? []) {
      tracked.delete(key);
      dismissed.delete(key);
    }
    switch (request.action) {
      case 'track':
        tracked.set(request.key, { at: now });
        break;
      case 'drop':
        tracked.delete(request.key);
        break;
      case 'dismiss':
        dismissed.set(request.key, { fingerprint: request.fingerprint ?? '', at: now });
        break;
      case 'undismiss':
        dismissed.delete(request.key);
        break;
    }
    if (tracked.size > MAX_MARKS || dismissed.size > MAX_MARKS) {
      throw new HttpError(400, `Too many marks (at most ${MAX_MARKS} of each kind)`);
    }
    this.persist(toMarks(tracked, dismissed));
    this.tracked = tracked;
    this.dismissed = dismissed;
    return this.marks;
  }

  private persist(marks: WorkMarks): void {
    if (this.file === null) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(marks, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  }
}
