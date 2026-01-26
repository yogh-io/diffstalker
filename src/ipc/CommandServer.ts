/**
 * Unix socket IPC server for remote control of diffstalker.
 * Receives JSON commands and dispatches them to the app.
 */

import * as net from 'net';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// App state exposed to external consumers
export interface AppState {
  // Current view
  currentTab: 'diff' | 'commit' | 'history' | 'compare' | 'explorer';
  currentPane: 'files' | 'diff' | 'commit' | 'history' | 'compare' | 'explorer';

  // File list state
  selectedIndex: number;
  totalFiles: number;
  stagedCount: number;
  files: Array<{
    path: string;
    status: string;
    staged: boolean;
  }>;

  // History state
  historySelectedIndex: number;
  historyCommitCount: number;

  // Compare state
  compareSelectedIndex: number;
  compareTotalItems: number;
  includeUncommitted: boolean;

  // Explorer state
  explorerPath: string;
  explorerSelectedIndex: number;
  explorerItemCount: number;

  // UI state
  wrapMode: boolean;
  mouseEnabled: boolean;
  autoTabEnabled: boolean;
}

// Command handler interface - implemented by App.tsx
export interface CommandHandler {
  // Navigation
  navigateUp(): void;
  navigateDown(): void;
  switchTab(tab: 'diff' | 'commit' | 'history' | 'compare' | 'explorer'): void;
  togglePane(): void;

  // Git operations
  stage(): Promise<void>;
  unstage(): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  commit(message: string): Promise<void>;
  refresh(): Promise<void>;

  // State queries
  getState(): AppState;

  // Control
  quit(): void;
}

// Command types
export type Command =
  | { action: 'ping' }
  | { action: 'navigateUp' }
  | { action: 'navigateDown' }
  | { action: 'switchTab'; tab: 'diff' | 'commit' | 'history' | 'compare' | 'explorer' }
  | { action: 'togglePane' }
  | { action: 'stage' }
  | { action: 'unstage' }
  | { action: 'stageAll' }
  | { action: 'unstageAll' }
  | { action: 'commit'; message: string }
  | { action: 'refresh' }
  | { action: 'getState' }
  | { action: 'quit' };

export interface CommandResult {
  success: boolean;
  error?: string;
  state?: AppState;
  ready?: boolean;
}

export class CommandServer extends EventEmitter {
  private server: net.Server | null = null;
  private socketPath: string;
  private handler: CommandHandler | null = null;
  private ready: boolean = false;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  /**
   * Set the command handler (called by App after initialization)
   */
  setHandler(handler: CommandHandler): void {
    this.handler = handler;
  }

  /**
   * Mark the app as ready (called after handler is set and app is initialized)
   */
  notifyReady(): void {
    this.ready = true;
    this.emit('ready');
  }

  /**
   * Check if the app is ready
   */
  isReady(): boolean {
    return this.ready && this.handler !== null;
  }

  /**
   * Start listening for connections
   */
  async start(): Promise<void> {
    // Remove existing socket file if it exists
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions to user-only
        fs.chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  /**
   * Stop the server and clean up
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // Clean up socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }

  /**
   * Handle an incoming connection
   */
  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          const result = await this.processCommand(line);
          socket.write(JSON.stringify(result) + '\n');
        }
      }
    });

    socket.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * Process a single command
   */
  private async processCommand(json: string): Promise<CommandResult> {
    try {
      const command = JSON.parse(json) as Command;

      // ping can be handled without a handler - used to check readiness
      if (command.action === 'ping') {
        return { success: true, ready: this.isReady() };
      }

      if (!this.handler) {
        return { success: false, error: 'No handler registered' };
      }

      switch (command.action) {
        case 'navigateUp':
          this.handler.navigateUp();
          return { success: true };

        case 'navigateDown':
          this.handler.navigateDown();
          return { success: true };

        case 'switchTab':
          this.handler.switchTab(command.tab);
          return { success: true };

        case 'togglePane':
          this.handler.togglePane();
          return { success: true };

        case 'stage':
          await this.handler.stage();
          return { success: true };

        case 'unstage':
          await this.handler.unstage();
          return { success: true };

        case 'stageAll':
          await this.handler.stageAll();
          return { success: true };

        case 'unstageAll':
          await this.handler.unstageAll();
          return { success: true };

        case 'commit':
          await this.handler.commit(command.message);
          return { success: true };

        case 'refresh':
          await this.handler.refresh();
          return { success: true };

        case 'getState':
          return { success: true, state: this.handler.getState() };

        case 'quit':
          this.handler.quit();
          return { success: true };

        default:
          return {
            success: false,
            error: `Unknown action: ${(command as { action: string }).action}`,
          };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
