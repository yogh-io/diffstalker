/**
 * Per-repo SSE hub.
 *
 * Each repo id gets one channel that subscribes to the core manager's
 * workingTree 'state-change' event and fans serialized SHARED state out to
 * every connected response. The channel is created lazily on the first
 * subscriber and torn down (listener removed, keep-alive cleared) when the
 * last subscriber disconnects.
 */

import type { ServerResponse } from 'node:http';
import type { GitStateManager } from '@diffstalker/core/managers/GitStateManager';
import type { GitState } from '@diffstalker/core/managers/WorkingTreeManager';
import { serializeSharedState } from './serialize.js';

const KEEP_ALIVE_MS = 25_000;

interface Channel {
  manager: GitStateManager;
  subscribers: Set<ServerResponse>;
  listener: (state: GitState) => void;
  keepAlive: ReturnType<typeof setInterval>;
}

function writeEvent(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

export class SseHub {
  private channels = new Map<string, Channel>();

  /**
   * Attach a response as a subscriber of a repo's state-change stream.
   * Sends an initial `snapshot` event with the current shared state, then
   * `state-change` events as the manager emits them.
   */
  subscribe(repoId: string, manager: GitStateManager, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let channel = this.channels.get(repoId);
    if (!channel) {
      const subscribers = new Set<ServerResponse>();
      const listener = (state: GitState): void => {
        const data = JSON.stringify(serializeSharedState(state));
        for (const subscriber of subscribers) {
          writeEvent(subscriber, 'state-change', data);
        }
      };
      manager.workingTree.on('state-change', listener);

      const keepAlive = setInterval(() => {
        for (const subscriber of subscribers) {
          subscriber.write(': ping\n\n');
        }
      }, KEEP_ALIVE_MS);
      keepAlive.unref();

      channel = { manager, subscribers, listener, keepAlive };
      this.channels.set(repoId, channel);
    }

    channel.subscribers.add(res);
    res.on('close', () => this.unsubscribe(repoId, res));

    const snapshot = JSON.stringify(serializeSharedState(manager.workingTree.state));
    writeEvent(res, 'snapshot', snapshot);
  }

  private unsubscribe(repoId: string, res: ServerResponse): void {
    const channel = this.channels.get(repoId);
    if (!channel) return;

    channel.subscribers.delete(res);
    if (channel.subscribers.size === 0) {
      this.teardown(repoId, channel);
    }
  }

  private teardown(repoId: string, channel: Channel): void {
    channel.manager.workingTree.off('state-change', channel.listener);
    clearInterval(channel.keepAlive);
    for (const subscriber of channel.subscribers) {
      subscriber.end();
    }
    channel.subscribers.clear();
    this.channels.delete(repoId);
  }

  /** Tear down a repo's channel (repo closed via DELETE). */
  closeRepo(repoId: string): void {
    const channel = this.channels.get(repoId);
    if (channel) this.teardown(repoId, channel);
  }

  /** Tear down every channel (daemon shutdown). */
  destroy(): void {
    for (const [repoId, channel] of this.channels) {
      this.teardown(repoId, channel);
    }
  }
}
