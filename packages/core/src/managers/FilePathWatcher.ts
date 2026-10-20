import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import * as logger from '../utils/logger.js';
import { ensureTargetDir, expandPath, getLastNonEmptyLine } from '../utils/pathUtils.js';

export interface WatcherState {
  path: string | null;
  rawContent: string | null;
}

type FilePathWatcherEventMap = {
  'path-change': [WatcherState];
};

/** Cooldown after a read; events inside it collapse into one trailing read. */
export const FILE_EVENT_COOLDOWN_MS = 100;

/**
 * FilePathWatcher watches a target file and emits events when the path it contains changes.
 * It supports append-only files by reading only the last non-empty line.
 */
export class FilePathWatcher extends EventEmitter<FilePathWatcherEventMap> {
  private targetFile: string;
  private watcher: FSWatcher | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private eventDuringCooldown = false;
  private lastReadPath: string | null = null;

  private _state: WatcherState = {
    path: null,
    rawContent: null,
  };

  constructor(
    targetFile: string,
    private cooldownMs: number = FILE_EVENT_COOLDOWN_MS
  ) {
    super();
    this.targetFile = targetFile;
  }

  get state(): WatcherState {
    return this._state;
  }

  private updateState(partial: Partial<WatcherState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('path-change', this._state);
  }

  private processContent(content: string): string | null {
    if (!content) return null;

    const expanded = expandPath(content);
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  }

  /**
   * A change to the file. The first event after a quiet period reads at
   * once; the cooldown that follows ends with one more read, so a burst
   * of writes ends on the newest target without opening every
   * intermediate one. That trailing read is unconditional because
   * chokidar drops (not delays) a change that lands within a few ms of
   * the previous one; the cooldown chains only while events keep coming.
   */
  onFileEvent(): void {
    if (this.cooldownTimer) {
      this.eventDuringCooldown = true;
      return;
    }
    this.readTarget();
    this.startCooldown();
  }

  private startCooldown(): void {
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      const again = this.eventDuringCooldown;
      this.eventDuringCooldown = false;
      this.readTarget();
      if (again) this.startCooldown();
    }, this.cooldownMs);
  }

  private readTarget(): void {
    try {
      const raw = fs.readFileSync(this.targetFile, 'utf-8');
      const content = getLastNonEmptyLine(raw);

      if (content && content !== this.lastReadPath) {
        const resolved = this.processContent(content);
        this.lastReadPath = resolved;
        this.updateState({
          path: resolved,
          rawContent: content,
        });
      }
    } catch (err) {
      // A tool that replaces the file (write to a temp name, rename over)
      // can make it briefly absent between the events; the next event
      // reads it. Anything else means follow mode is not seeing targets.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.warn('Cannot read the follow hook file', err, { file: this.targetFile });
    }
  }

  /**
   * Start watching the target file.
   */
  start(): void {
    // Ensure the directory exists
    ensureTargetDir(this.targetFile);

    // Create the file if it doesn't exist
    if (!fs.existsSync(this.targetFile)) {
      fs.writeFileSync(this.targetFile, '');
    }

    // Read the initial value; it is state, not an event (no emit).
    try {
      const raw = fs.readFileSync(this.targetFile, 'utf-8');
      const content = getLastNonEmptyLine(raw);

      if (content) {
        const resolved = this.processContent(content);
        this.lastReadPath = resolved;
        this._state = {
          path: resolved,
          rawContent: content,
        };
        // Don't emit on initial read - caller should check state after start()
      }
    } catch (err) {
      // The file exists (created just above when missing), so this is a
      // real failure: the last-written target is lost until the next write.
      logger.warn('Cannot read the follow hook file', err, { file: this.targetFile });
    }

    // Watch for changes
    this.watcher = watch(this.targetFile, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('change', () => this.onFileEvent());
    this.watcher.on('add', () => this.onFileEvent());
    // An EventEmitter 'error' with no listener takes the daemon down. The
    // other watchers surface theirs into state; this one has no error slot,
    // so it is logged.
    this.watcher.on('error', (err: unknown) => {
      logger.warn('Follow hook file watcher error', err, { file: this.targetFile });
    });
  }

  /**
   * Stop watching and clean up resources.
   */
  stop(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.eventDuringCooldown = false;
    if (this.watcher) {
      // close() is async; a rejection here would otherwise be unhandled.
      this.watcher.close().catch((err: unknown) => {
        logger.warn('Failed to close the follow hook file watcher', err, {
          file: this.targetFile,
        });
      });
      this.watcher = null;
    }
  }
}
