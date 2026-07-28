/**
 * StatusBar tests: the version indicator — what it shows for each
 * running-vs-npm outcome, and that it stays hidden when the daemon
 * cannot say what it is running.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StatusBar from './StatusBar.vue';
import { useDaemonStore } from '../stores/daemon';
import type { VersionState } from '@diffstalker/client';

function mountBar(version: VersionState | null): VueWrapper {
  useDaemonStore().version = version;
  return mount(StatusBar);
}

function indicator(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="version"]');
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('version indicator', () => {
  test('a matching version shows just the running one', () => {
    const el = indicator(mountBar({ current: '0.8.1', latest: '0.8.1', status: 'current' }));

    expect(el.text()).toBe('v0.8.1');
    expect(el.attributes('data-state')).toBe('current');
    expect(el.attributes('title')).toContain('up to date');
  });

  test('an older version names the newer one', () => {
    const el = indicator(mountBar({ current: '0.8.1', latest: '0.9.0', status: 'outdated' }));

    expect(el.text()).toBe('v0.8.1 → 0.9.0');
    expect(el.attributes('data-state')).toBe('outdated');
    expect(el.attributes('title')).toContain('0.9.0');
  });

  test('a local build ahead of npm is marked, not flagged as an update', () => {
    const el = indicator(mountBar({ current: '0.9.0', latest: '0.8.1', status: 'ahead' }));

    expect(el.text()).toBe('v0.9.0');
    expect(el.attributes('data-state')).toBe('ahead');
    expect(el.attributes('title')).toContain('ahead of npm');
  });

  test('an unreachable registry still shows the running version', () => {
    const el = indicator(mountBar({ current: '0.8.1', latest: null, status: 'unknown' }));

    expect(el.text()).toBe('v0.8.1');
    expect(el.attributes('data-state')).toBe('unknown');
  });

  test('nothing is shown before the version loads', () => {
    expect(indicator(mountBar(null)).exists()).toBe(false);
  });

  test('nothing is shown when the daemon cannot read its own version', () => {
    const el = indicator(mountBar({ current: null, latest: '0.9.0', status: 'unknown' }));

    expect(el.exists()).toBe(false);
  });
});
