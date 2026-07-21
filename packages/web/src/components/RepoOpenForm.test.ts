/**
 * RepoOpenForm tests: the inline error shows only a refused open
 * (not-a-repo mode), never a live repo's error; the submit button is
 * disabled for an empty/whitespace path and while an open is in
 * flight; a successful open clears the path and emits `opened`.
 * Driven by the fake fetch + FakeEventSource — no daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RepoOpenForm from './RepoOpenForm.vue';
import { useRepoStore } from '../stores/repo';
import { makeFakeFetch, FakeEventSource, Deferred } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';

let fake: FakeFetch;
let onRequest: ((call: FetchCall) => FakeResponse | Promise<FakeResponse> | undefined) | null;

function routes(call: FetchCall): FakeResponse {
  if (call.method === 'POST' && call.url === '/repos') {
    return { body: { id: 'r1', path: (call.body as { path: string }).path } };
  }
  if (call.method === 'DELETE' && call.url.startsWith('/repos/')) {
    return { body: null };
  }
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

function inputValue(wrapper: ReturnType<typeof mount>): string {
  return (wrapper.find('input').element as HTMLInputElement).value;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? routes(call));
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('open error display', () => {
  test('shows repo.shared.error while in not-a-repo mode', () => {
    const repo = useRepoStore();
    repo.shared = { ...repo.shared, error: 'Not a git repository: /nope' };
    const wrapper = mount(RepoOpenForm);
    expect(wrapper.find('.form-error').text()).toBe('Not a git repository: /nope');
  });

  test("a live repo's error is NOT the form's to show", () => {
    const repo = useRepoStore();
    repo.repoId = 'r1';
    repo.shared = { ...repo.shared, error: 'push failed' };
    const wrapper = mount(RepoOpenForm);
    expect(wrapper.find('.form-error').exists()).toBe(false);
  });

  test('a refused open surfaces the daemon reason inline, keeps the path', async () => {
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos'
        ? { status: 400, body: { error: 'Not a git repository: /nope' } }
        : undefined;
    const wrapper = mount(RepoOpenForm);

    await wrapper.find('input').setValue('/nope');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('.form-error').text()).toBe('Not a git repository: /nope');
    expect(wrapper.emitted('opened')).toBeUndefined();
    // The typed path stays put for correction.
    expect(inputValue(wrapper)).toBe('/nope');
  });
});

describe('submit button', () => {
  test('disabled for an empty or whitespace-only path, enabled otherwise', async () => {
    const wrapper = mount(RepoOpenForm);
    const button = wrapper.find('button');

    expect(button.attributes('disabled')).toBeDefined();

    await wrapper.find('input').setValue('   ');
    expect(button.attributes('disabled')).toBeDefined();

    await wrapper.find('input').setValue('/repo');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  test('disabled while the open is in flight; a re-submit sends no second POST', async () => {
    const gate = new Deferred<FakeResponse>();
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos' ? gate.promise : undefined;
    const wrapper = mount(RepoOpenForm);

    await wrapper.find('input').setValue('/repo');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();

    // The busy guard swallows a second submit while the first is in flight.
    await wrapper.find('form').trigger('submit');
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    gate.resolve({ body: { id: 'r1', path: '/repo' } });
    await flushPromises();
    expect(wrapper.emitted('opened')).toHaveLength(1);
  });

  test('a successful open clears the path and emits opened', async () => {
    const wrapper = mount(RepoOpenForm);

    await wrapper.find('input').setValue('/repo');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.emitted('opened')).toHaveLength(1);
    expect(inputValue(wrapper)).toBe('');
    // Path cleared: the button falls back to disabled.
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
  });
});
