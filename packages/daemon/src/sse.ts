/**
 * SSE hubs.
 *
 * SseHub is the per-repo hub: each repo id gets one channel that subscribes
 * to the core manager's workingTree 'state-change' event and fans serialized
 * SHARED state out to every connected response, plus the journal's 'append'
 * event fanned out as `journal-append {epoch, entries}` on the same channel
 * (the epoch lets clients drop a batch that raced a store reset instead of
 * splicing entries from two seq spaces together). The channel is
 * created lazily on the first subscriber and torn down (listeners removed,
 * keep-alive cleared) when the last subscriber disconnects.
 *
 * DaemonEventHub is the single daemon-scope channel (GET /events): named
 * events about the daemon itself — repo-opened, repo-closed, follow-change —
 * broadcast to every subscriber. It holds no per-repo state; producers
 * (registry callbacks, the follow controller) push events into it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitStateManager } from '@diffstalker/core/managers/GitStateManager';
import type { GitState } from '@diffstalker/core/managers/WorkingTreeManager';
import type { JournalEntry } from '@diffstalker/core/types/journal';
import { serializeSharedState, serializeJournalEntries } from './serialize.js';

const KEEP_ALIVE_MS = 25_000;

interface Channel {
  manager: GitStateManager;
  subscribers: Set<ServerResponse>;
  listener: (state: GitState) => void;
  /** Fans one observation's appended journal entries out as journal-append. */
  journalListener: (entries: JournalEntry[]) => void;
  keepAlive: ReturnType<typeof setInterval>;
  /** Last state-change payload fanned out; identical payloads are skipped. */
  lastData: string | null;
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
  subscribe(
    repoId: string,
    manager: GitStateManager,
    req: IncomingMessage,
    res: ServerResponse
  ): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let channel = this.channels.get(repoId);
    if (!channel) {
      const subscribers = new Set<ServerResponse>();
      const newChannel: Channel = {
        manager,
        subscribers,
        listener: (state: GitState): void => {
          const data = JSON.stringify(serializeSharedState(state));
          // The manager emits state-change even when the shared fields did
          // not change (e.g. the isLoading:true edge of a refresh); skip
          // fan-out when the payload is identical to the last one sent.
          if (data === newChannel.lastData) return;
          newChannel.lastData = data;
          for (const subscriber of subscribers) {
            writeEvent(subscriber, 'state-change', data);
          }
        },
        journalListener: (entries: JournalEntry[]): void => {
          // No lastData-style dedup: appends are inherently new. One event
          // per observation so clients apply the batch atomically. The
          // store's epoch rides along so a client can tell a batch from a
          // reset store apart from its own cached seq space (an epoch-less
          // append racing a reset would splice into the wrong log).
          const data = JSON.stringify({
            epoch: manager.journal.journalStore.epoch,
            entries: serializeJournalEntries(entries),
          });
          for (const subscriber of subscribers) {
            writeEvent(subscriber, 'journal-append', data);
          }
        },
        keepAlive: setInterval(() => {
          for (const subscriber of subscribers) {
            subscriber.write(': ping\n\n');
          }
        }, KEEP_ALIVE_MS),
        lastData: null,
      };
      manager.workingTree.on('state-change', newChannel.listener);
      manager.journal.on('append', newChannel.journalListener);
      newChannel.keepAlive.unref();

      channel = newChannel;
      this.channels.set(repoId, channel);
    }

    channel.subscribers.add(res);
    // Hang teardown on the REQUEST's close event: node fires 'close' on
    // both req and res, but bun only fires it on req — using res here
    // leaks the listener and channel for every disconnected client.
    req.on('close', () => this.unsubscribe(repoId, res));

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
    channel.manager.journal.off('append', channel.journalListener);
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

/**
 * The daemon-scope SSE channel: one subscriber set, named events pushed by
 * producers via broadcast(). On connect the caller supplies a snapshot
 * payload (the currently-open repos) sent as the initial `snapshot` event.
 */
export class DaemonEventHub {
  private subscribers = new Set<ServerResponse>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  subscribe(req: IncomingMessage, res: ServerResponse, snapshot: unknown): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    this.subscribers.add(res);
    if (!this.keepAlive) {
      this.keepAlive = setInterval(() => {
        for (const subscriber of this.subscribers) {
          subscriber.write(': ping\n\n');
        }
      }, KEEP_ALIVE_MS);
      this.keepAlive.unref();
    }

    // Teardown on the REQUEST's close event, same as the per-repo hub:
    // bun only fires 'close' on req, not res.
    req.on('close', () => {
      this.subscribers.delete(res);
      if (this.subscribers.size === 0 && this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
    });

    writeEvent(res, 'snapshot', JSON.stringify(snapshot));
  }

  /** Fan a named event out to every subscriber (no-op with none). */
  broadcast(event: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const subscriber of this.subscribers) {
      writeEvent(subscriber, event, data);
    }
  }

  /** End every stream and stop the keep-alive (daemon shutdown). */
  destroy(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    for (const subscriber of this.subscribers) {
      subscriber.end();
    }
    this.subscribers.clear();
  }
}
