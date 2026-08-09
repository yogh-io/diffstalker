/**
 * Daemon settings: the small, persistent configuration the daemon owns on
 * behalf of every client.
 *
 * These are machine settings, not view settings. A browser cannot scan a
 * filesystem and a per-client copy would disagree the moment a second
 * client connected, so "where my projects live" belongs here — one file,
 * one answer, surviving a daemon restart. Client-side taste (theme, split
 * ratios) stays in the client; nothing about a browser goes in this file.
 *
 * Stored as JSON at ~/.config/diffstalker/daemon.json, written atomically
 * (write a sibling temp file, rename over the target) so a crash mid-write
 * cannot leave a half-file that reads as "no settings". Every field is
 * validated on read: an unparseable or hand-mangled file degrades to the
 * defaults rather than throwing at startup.
 *
 * A store with no file is a real, reported state — `persisted: false` on
 * GET /settings — not a silent variant. Settings still apply for the
 * daemon's lifetime; they just don't outlive it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandPath } from '@diffstalker/core/utils/pathUtils';
import { error as logError } from '@diffstalker/core/utils/logger';

export interface DaemonSettings {
  /**
   * Directories to scan for git repositories — the parent folders a user
   * keeps projects in. Absolute, deduped, in the order the user gave them.
   */
  watchRoots: string[];
}

export function defaultSettings(): DaemonSettings {
  return { watchRoots: [] };
}

/** How many watch roots one daemon will hold. */
export const MAX_WATCH_ROOTS = 16;

/**
 * Normalize one user-supplied watch directory, at the daemon's trust
 * boundary — the same treatment a repo path gets in the registry: `~` is
 * expanded (the daemon's home IS the user's home), and a path that is
 * still relative afterwards is refused rather than resolved against the
 * daemon's working directory, which the client knows nothing about.
 *
 * Throws with a message meant for the person who typed the path.
 */
export function normalizeWatchRoot(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Watch directory cannot be empty');

  const expanded = expandPath(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`Watch directory must be absolute: ${input}`);
  }

  const resolved = path.resolve(expanded);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`No such directory: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Normalize a whole list, keeping the user's order and dropping repeats
 * (two spellings of one directory normalize to the same path).
 */
export function normalizeWatchRoots(inputs: string[]): string[] {
  if (inputs.length > MAX_WATCH_ROOTS) {
    throw new Error(`Too many watch directories (max ${MAX_WATCH_ROOTS})`);
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const input of inputs) {
    const root = normalizeWatchRoot(input);
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

/** Believe only the fields we recognize, in the shape we expect. */
function sanitize(raw: unknown): DaemonSettings {
  const settings = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return settings;
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.watchRoots)) {
    settings.watchRoots = record.watchRoots
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, MAX_WATCH_ROOTS);
  }
  return settings;
}

export class SettingsStore {
  private current: DaemonSettings = defaultSettings();

  /** `file` null means memory-only: settings apply but are not persisted. */
  constructor(private file: string | null) {}

  get settings(): DaemonSettings {
    return this.current;
  }

  get persisted(): boolean {
    return this.file !== null;
  }

  /**
   * Read the file into memory. A missing file is the normal first-run
   * state; an unreadable or invalid one logs and falls back to defaults,
   * because refusing to start over a bad config file would take the git
   * state down with it.
   *
   * A stored root is NOT re-validated here: a directory that is
   * temporarily gone (an unmounted disk) must stay in the list, or the
   * first save after a reboot would quietly delete it. Discovery reports
   * it as a root with an error instead.
   */
  load(): DaemonSettings {
    if (!this.file) return this.current;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return this.current; // no file yet
    }
    try {
      this.current = sanitize(JSON.parse(text));
    } catch (err) {
      logError(`Ignoring invalid settings file ${this.file}: ${String(err)}`);
    }
    return this.current;
  }

  /** Replace the settings and persist them. Throws if the write fails. */
  save(next: DaemonSettings): DaemonSettings {
    this.current = next;
    if (!this.file) return this.current;

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    return this.current;
  }
}
