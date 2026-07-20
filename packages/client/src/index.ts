/**
 * @diffstalker/client: a typed REST + SSE client for diffstalkerd over a
 * unix socket or TCP. Runtime dependencies are node builtins only; DTO
 * types come type-only from @diffstalker/core.
 */

export { DiffstalkerClient } from './client.js';
export type {
  RepoSubscription,
  DaemonSubscription,
  RepoSubscriptionEvents,
  DaemonSubscriptionEvents,
} from './client.js';
export { DaemonError, isConnectionError } from './transport.js';
export type { TransportTarget, HttpMethod } from './transport.js';
export type * from './wire.js';
