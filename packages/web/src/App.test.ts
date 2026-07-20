/**
 * Smoke test: the test harness exists for later slices. Mounts the
 * placeholder App with a stubbed fetch (no real daemon in unit tests).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import App from './App.vue';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, ready: true }),
    }))
  );
});

describe('App', () => {
  test('renders the app name and the daemon health line', async () => {
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    expect(wrapper.text()).toContain('diffstalker');

    await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/health');
    expect(wrapper.text()).toContain('ok=true ready=true');
  });
});
