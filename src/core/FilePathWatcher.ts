import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { ensureTargetDir } from '../config.js';
import { expandPath, getLastNonEmptyLine } from '../utils/pathUtils.js';

export interface WatcherState {
  path: string | null;
  lastUpdate: Date | null;
  rawContent: string | null;
  sourceFile: string | null;
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
  private debug: boolean;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReadPath: string | null = null;

  private _state: WatcherState = {
    path: null,
    lastUpdate: null,
    rawContent: null,
    sourceFile: null,
  };

  constructor(targetFile: string, debug: boolean = false) {
    super();
    this.targetFile = targetFile;
    this.debug = debug;
    this._state.sourceFile = targetFile;
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
        const now = new Date();

        if (this.debug && resolved) {
          process.stderr.write(`[diffstalker ${now.toISOString()}] Path change detected\n`);
          process.stderr.write(`  Source file: ${this.targetFile}\n`);
          process.stderr.write(`  Raw content: "${content}"\n`);
          process.stderr.write(`  Previous:    "${this.lastReadPath ?? '(none)'}"\n`);
          process.stderr.write(`  Resolved:    "${resolved}"\n`);
        }

        this.lastReadPath = resolved;
        this.updateState({
          path: resolved,
          lastUpdate: now,
          rawContent: content,
        });
      }
    } catch {
      // Ignore read errors
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
        const now = new Date();

        if (this.debug && resolved) {
          process.stderr.write(`[diffstalker ${now.toISOString()}] Initial path read\n`);
          process.stderr.write(`  Source file: ${this.targetFile}\n`);
          process.stderr.write(`  Raw content: "${content}"\n`);
          process.stderr.write(`  Resolved:    "${resolved}"\n`);
        }

        this.lastReadPath = resolved;
        this._state = {
          path: resolved,
          lastUpdate: now,
          rawContent: content,
          sourceFile: this.targetFile,
        };
        // Don't emit on initial read - caller should check state after start()
      }
    } catch {
      // Ignore read errors
    }

    // Watch for changes
    this.watcher = watch(this.targetFile, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on('change', () => this.readTargetDebounced());
    this.watcher.on('add', () => this.readTargetDebounced());
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
      this.watcher.close();
      this.watcher = null;
    }
  }
}
