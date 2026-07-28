import type { WorktreeInfo } from '@diffstalker/client';

/**
 * Test doubles for the browser data layer: a fake global fetch driven by
 * a route handler, and a FakeEventSource standing in for the browser's
 * EventSource. No real daemon is ever touched — tests stub the globals
 * (vi.stubGlobal) and drive these directly.
 */

/** One recorded fetch call, body already JSON-parsed. */
export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** What a route handler answers with. */
export interface FakeResponse {
  status?: number;
  /** JSON body; omit for an empty body. */
  body?: unknown;
  /** Raw body text; wins over `body` (for invalid-JSON tests). */
  rawBody?: string;
}

export type RouteHandler = (call: FetchCall) => FakeResponse | Promise<FakeResponse>;

export interface FakeFetch {
  /** Install with vi.stubGlobal('fetch', fake.fn). */
  fn: typeof fetch;
  calls: FetchCall[];
  /** calls filtered on a URL substring. */
  callsTo(fragment: string): FetchCall[];
}

/** Build a fake fetch: every request goes through the route handler. */
export function makeFakeFetch(handler: RouteHandler): FakeFetch {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const res = await handler(call);
    const status = res.status ?? 200;
    const text = res.rawBody ?? (res.body === undefined ? '' : JSON.stringify(res.body));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as typeof fetch;
  return {
    fn,
    calls,
    callsTo(fragment: string): FetchCall[] {
      return calls.filter((call) => call.url.includes(fragment));
    },
  };
}

/** A promise with its resolvers exposed, for ordering-sensitive tests. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (err: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

type Listener = (event: MessageEvent<string>) => void;

/**
 * Stand-in for the browser's EventSource. Install with
 * vi.stubGlobal('EventSource', FakeEventSource) and call
 * FakeEventSource.reset() in beforeEach. Tests push events with
 * emit()/open()/fail().
 */
export class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }

  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('no FakeEventSource was constructed');
    return source;
  }

  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: Listener): void {
    const existing = this.listeners.get(name) ?? [];
    this.listeners.set(name, [...existing, listener]);
  }

  close(): void {
    this.closed = true;
  }

  /** Dispatch a named event with a JSON payload. */
  emit(name: string, payload: unknown): void {
    this.emitRaw(name, JSON.stringify(payload));
  }

  /** Dispatch a named event with raw data (invalid-JSON tests). */
  emitRaw(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data } as MessageEvent<string>);
    }
  }

  /** Simulate the stream (re)opening. */
  open(): void {
    this.onopen?.();
  }

  /** Simulate a connection drop / SSE error. */
  fail(): void {
    this.onerror?.();
  }
}

/**
 * A WorktreeInfo fixture.
 *
 * `main` marks the repository's MAIN worktree — the first entry `git
 * worktree list` reports, and the family's identity. Exactly one worktree
 * per family has it. In a bare setup that entry IS the bare git dir, so
 * pass `{ main: true, bare: true }` for it.
 */
export function worktree(
  path: string,
  branch: string | null,
  opts: { main?: boolean; bare?: boolean; lastActivity?: number | null; aheadOfBase?: number | null } = {}
): WorktreeInfo {
  return {
    path,
    branch,
    head: 'abc123',
    isMain: opts.main ?? false,
    isBare: opts.bare ?? false,
    lastActivity: opts.lastActivity ?? null,
    aheadOfBase: opts.aheadOfBase ?? null,
  };
}
