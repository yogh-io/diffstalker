/**
 * Unix socket IPC client for controlling diffstalker remotely.
 * Sends JSON commands and receives responses.
 */

import * as net from 'net';
import type { Command, CommandResult, AppState } from './CommandServer.js';

export class CommandClient {
  private socketPath: string;
  private timeout: number;

  constructor(socketPath: string, timeout: number = 5000) {
    this.socketPath = socketPath;
    this.timeout = timeout;
  }

  /**
   * Send a command and wait for response
   */
  async send(command: Command): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.destroy();
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Command timed out after ${this.timeout}ms`));
      }, this.timeout);

      socket.on('connect', () => {
        socket.write(JSON.stringify(command) + '\n');
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex !== -1) {
          const json = buffer.substring(0, newlineIndex);
          cleanup();
          try {
            resolve(JSON.parse(json) as CommandResult);
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${json}`));
          }
        }
      });

      socket.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  // Convenience methods for common operations

  async navigateUp(): Promise<CommandResult> {
    return this.send({ action: 'navigateUp' });
  }

  async navigateDown(): Promise<CommandResult> {
    return this.send({ action: 'navigateDown' });
  }

  async switchTab(
    tab: 'diff' | 'commit' | 'history' | 'compare' | 'explorer'
  ): Promise<CommandResult> {
    return this.send({ action: 'switchTab', tab });
  }

  async togglePane(): Promise<CommandResult> {
    return this.send({ action: 'togglePane' });
  }

  async stage(): Promise<CommandResult> {
    return this.send({ action: 'stage' });
  }

  async unstage(): Promise<CommandResult> {
    return this.send({ action: 'unstage' });
  }

  async stageAll(): Promise<CommandResult> {
    return this.send({ action: 'stageAll' });
  }

  async unstageAll(): Promise<CommandResult> {
    return this.send({ action: 'unstageAll' });
  }

  async commit(message: string): Promise<CommandResult> {
    return this.send({ action: 'commit', message });
  }

  async refresh(): Promise<CommandResult> {
    return this.send({ action: 'refresh' });
  }

  async getState(): Promise<AppState> {
    const result = await this.send({ action: 'getState' });
    if (!result.success) {
      throw new Error(result.error || 'Failed to get state');
    }
    if (!result.state) {
      throw new Error('No state returned');
    }
    return result.state;
  }

  async quit(): Promise<CommandResult> {
    return this.send({ action: 'quit' });
  }

  /**
   * Ping the server to check if it's ready
   * Returns { success: true, ready: boolean }
   */
  async ping(): Promise<CommandResult> {
    return this.send({ action: 'ping' });
  }

  /**
   * Wait for the server socket file to exist
   */
  async waitForSocketFile(maxWait: number = 10000, pollInterval: number = 100): Promise<void> {
    const fs = await import('fs');
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (fs.existsSync(this.socketPath)) {
        return; // Socket file exists
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    throw new Error(`Socket file not found after ${maxWait}ms: ${this.socketPath}`);
  }

  /**
   * Wait for the server socket to be available and accepting connections
   */
  async waitForSocket(maxWait: number = 10000, pollInterval: number = 100): Promise<void> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    let attempts = 0;

    // First wait for the socket file to exist
    await this.waitForSocketFile(maxWait, pollInterval);

    // Then wait for it to accept connections
    while (Date.now() - startTime < maxWait) {
      attempts++;
      try {
        await this.ping();
        return; // Socket is available
      } catch (err) {
        // Socket not available yet, wait and retry
        lastError = err as Error;
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
    throw new Error(
      `Socket not accepting connections after ${maxWait}ms (${attempts} attempts). Last error: ${lastError?.message}`
    );
  }

  /**
   * Wait for the server to be fully ready (socket + handler registered)
   */
  async waitForServer(maxWait: number = 10000, pollInterval: number = 100): Promise<void> {
    const startTime = Date.now();

    // First wait for socket to be available
    await this.waitForSocket(maxWait, pollInterval);

    // Then wait for the app to be ready (handler registered)
    while (Date.now() - startTime < maxWait) {
      try {
        const result = await this.ping();
        if (result.success && result.ready) {
          return; // App is ready
        }
        // Socket available but handler not ready yet
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch {
        // Connection failed, wait and retry
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
    throw new Error(`Server not ready after ${maxWait}ms`);
  }
}

// Export types for consumers
export type { Command, CommandResult, AppState };
