/**
 * Browser transport tests: fetch-based request() error taxonomy and the
 * EventSource-based subscribe(). Globals are stubbed — no daemon, no
 * network.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { request, subscribe } from './transport';
import { DaemonError, isConnectionError } from './errors';
import { makeFakeFetch, FakeEventSource } from '../testing/fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  test('resolves parsed JSON on 200', async () => {
    const fake = makeFakeFetch(() => ({ body: { ok: true, ready: true } }));
    vi.stubGlobal('fetch', fake.fn);

    await expect(request('GET', '/health')).resolves.toEqual({ ok: true, ready: true });
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: '/health' });
  });

  test('resolves null on an empty 2xx body', async () => {
    const fake = makeFakeFetch(() => ({ status: 204 }));
    vi.stubGlobal('fetch', fake.fn);

    await expect(request('DELETE', '/repos/x')).resolves.toBeNull();
  });

  test('sends a JSON body with content-type for POST', async () => {
    const fake = makeFakeFetch(() => ({ body: { id: 'r1', path: '/repo' } }));
    vi.stubGlobal('fetch', fake.fn);

    await request('POST', '/repos', { path: '/repo' });
    expect(fake.calls[0].body).toEqual({ path: '/repo' });
    expect(fake.calls[0].headers['content-type']).toBe('application/json');
  });

  test('sends no body or content-type for GET', async () => {
    const fake = makeFakeFetch(() => ({ body: [] }));
    vi.stubGlobal('fetch', fake.fn);

    await request('GET', '/repos');
    expect(fake.calls[0].body).toBeUndefined();
    expect(fake.calls[0].headers['content-type']).toBeUndefined();
  });

  test('non-2xx with {error} rejects with a DaemonError carrying status and message', async () => {
    const fake = makeFakeFetch(() => ({ status: 409, body: { error: 'push rejected' } }));
    vi.stubGlobal('fetch', fake.fn);

    const err = await request('POST', '/repos/x/push').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).status).toBe(409);
    expect((err as DaemonError).message).toBe('push rejected');
  });

  test('non-2xx without a body gets the generic message', async () => {
    const fake = makeFakeFetch(() => ({ status: 500 }));
    vi.stubGlobal('fetch', fake.fn);

    const err = await request('GET', '/repos/x/status').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).message).toBe('Daemon request failed with HTTP 500');
  });

  test('invalid JSON rejects with a DaemonError (the daemon answered, badly)', async () => {
    const fake = makeFakeFetch(() => ({ rawBody: 'not json' }));
    vi.stubGlobal('fetch', fake.fn);

    const err = await request('GET', '/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).message).toContain('invalid JSON');
    expect(isConnectionError(err)).toBe(false);
  });

  test('a rejected fetch is a connection error, not a DaemonError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const err = await request('GET', '/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DaemonError);
    expect(isConnectionError(err)).toBe(true);
    expect((err as Error).message).toContain('Failed to fetch');
  });

  test('a body read dying mid-flight is a connection error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new TypeError('network error');
        },
      }))
    );

    const err = await request('GET', '/health').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DaemonError);
    expect(isConnectionError(err)).toBe(true);
  });
});

describe('error classification', () => {
  test('isConnectionError: DaemonError no, everything else yes', () => {
    expect(isConnectionError(new DaemonError(404, 'unknown repo'))).toBe(false);
    expect(isConnectionError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectionError(new Error('socket hang up'))).toBe(true);
    expect(isConnectionError('weird string throw')).toBe(true);
  });
});

describe('subscribe', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  test('registers a listener per named event and delivers parsed payloads', () => {
    const events: Array<[string, unknown]> = [];
    subscribe('/repos/r1/events', ['snapshot', 'state-change'], {
      onEvent: (event, payload) => events.push([event, payload]),
    });

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/repos/r1/events');
    source.emit('snapshot', { status: null });
    source.emit('state-change', { status: { files: [] } });
    expect(events).toEqual([
      ['snapshot', { status: null }],
      ['state-change', { status: { files: [] } }],
    ]);
  });

  test('empty event data becomes a null payload', () => {
    const events: Array<[string, unknown]> = [];
    subscribe('/events', ['snapshot'], {
      onEvent: (event, payload) => events.push([event, payload]),
    });

    FakeEventSource.latest().emitRaw('snapshot', '');
    expect(events).toEqual([['snapshot', null]]);
  });

  test('invalid JSON in an event routes to onError, not onEvent', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribe('/events', ['snapshot'], { onEvent, onError });

    FakeEventSource.latest().emitRaw('snapshot', '{broken');
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('forwards onOpen and onError', () => {
    const onOpen = vi.fn();
    const onError = vi.fn();
    subscribe('/events', ['snapshot'], { onEvent: vi.fn(), onOpen, onError });

    const source = FakeEventSource.latest();
    source.open();
    source.fail();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('close() closes the EventSource and silences every callback', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const onOpen = vi.fn();
    const handle = subscribe('/events', ['snapshot'], { onEvent, onError, onOpen });

    const source = FakeEventSource.latest();
    handle.close();
    expect(source.closed).toBe(true);

    source.emit('snapshot', {});
    source.open();
    source.fail();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Idempotent.
    handle.close();
  });
});
