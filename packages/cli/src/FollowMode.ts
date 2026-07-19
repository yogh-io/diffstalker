import { FilePathWatcher, WatcherState as FileWatcherState } from './core/FilePathWatcher.js';

export interface FollowModeWatcherState {
  enabled: boolean;
  sourceFile?: string;
  rawContent?: string;
  lastUpdate?: Date;
}

/**
 * Callbacks invoked by FollowMode when repository or file changes occur.
 */
export interface FollowModeCallbacks {
  /**
   * Called when the watcher detects a new repository path.
   * The callback should switch to the new repo.
   */
  onRepoChange(newPath: string, state: FollowModeWatcherState): void;

  /**
   * Called when the watcher detects a file to navigate to.
   */
  onFileNavigate(rawContent: string): void;
}

/**
 * Manages the file-watching follow mode.
 * Watches a target file for repository path changes and file navigation.
 */
export class FollowMode {
  private watcher: FilePathWatcher | null = null;
  private _watcherState: FollowModeWatcherState = { enabled: false };

  constructor(
    private targetFile: string,
    private getCurrentRepoPath: () => string,
    private callbacks: FollowModeCallbacks
  ) {}

  get watcherState(): FollowModeWatcherState {
    return this._watcherState;
  }

  get isEnabled(): boolean {
    return this.watcher !== null;
  }

  /**
   * Start watching the target file.
   */
  start(): void {
    this.watcher = new FilePathWatcher(this.targetFile);

    this.watcher.on('path-change', (state: FileWatcherState) => {
      if (state.path && state.path !== this.getCurrentRepoPath()) {
        this._watcherState = {
          enabled: true,
          sourceFile: state.sourceFile ?? this.targetFile,
          rawContent: state.rawContent ?? undefined,
          lastUpdate: state.lastUpdate ?? undefined,
        };
        this.callbacks.onRepoChange(state.path, this._watcherState);
      }
      // Navigate to the followed file if it's within the repo
      if (state.rawContent) {
        this.callbacks.onFileNavigate(state.rawContent);
      }
    });

    this._watcherState = {
      enabled: true,
      sourceFile: this.targetFile,
    };

    this.watcher.start();

    // Switch to the repo described in the target file
    const initialState = this.watcher.state;
    if (initialState.path && initialState.path !== this.getCurrentRepoPath()) {
      this._watcherState = {
        enabled: true,
        sourceFile: initialState.sourceFile ?? this.targetFile,
        rawContent: initialState.rawContent ?? undefined,
        lastUpdate: initialState.lastUpdate ?? undefined,
      };
      this.callbacks.onRepoChange(initialState.path, this._watcherState);
    } else if (initialState.rawContent) {
      this._watcherState.rawContent = initialState.rawContent;
      this.callbacks.onFileNavigate(initialState.rawContent);
    }
  }

  /**
   * Toggle follow mode on/off.
   */
  toggle(): void {
    if (this.watcher) {
      this.stop();
    } else {
      this.start();
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
      this._watcherState = { enabled: false };
    }
  }
}
