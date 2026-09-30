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

/**
 * FilePathWatcher watches a target file and emits events when the path it contains changes.
 * It supports append-only files by reading only the last non-empty line.
 */
export class FilePathWatcher extends EventEmitter<FilePathWatcherEventMap> {
  private targetFile: string;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReadPath: string | null = null;

  private _state: WatcherState = {
    path: null,
    rawContent: null,
  };

  constructor(targetFile: string) {
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

  private readTargetDebounced(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.readTarget();
    }, 100);
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

    // Read initial value immediately (no debounce for first read)
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

    this.watcher.on('change', () => this.readTargetDebounced());
    this.watcher.on('add', () => this.readTargetDebounced());
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
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
