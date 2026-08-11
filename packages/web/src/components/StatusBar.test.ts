/**
 * StatusBar tests: the version indicator — what it shows for each
 * running-vs-npm outcome, that it stays hidden when the daemon cannot say
 * what it is running, and the click that copies the update command for the
 * way this daemon was actually installed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StatusBar from './StatusBar.vue';
import { useDaemonStore } from '../stores/daemon';
import type { InstallInfo, VersionState } from '@diffstalker/client';

const UNKNOWN_INSTALL: InstallInfo = { method: 'unknown', package: null, command: null };
const NPM_INSTALL: InstallInfo = {
  method: 'npm',
  package: 'diffstalkerd',
  command: 'npm install -g diffstalkerd',
};

/** A version state with the install half defaulted to an unnamed install. */
function state(partial: Omit<VersionState, 'install'>, install = UNKNOWN_INSTALL): VersionState {
  return { ...partial, install };
}

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
    const el = indicator(mountBar(state({ current: '0.8.1', latest: '0.8.1', status: 'current' })));

    expect(el.text()).toBe('v0.8.1');
    expect(el.attributes('data-state')).toBe('current');
    expect(el.attributes('title')).toContain('up to date');
  });

  test('an older version names the newer one', () => {
    const el = indicator(mountBar(state({ current: '0.8.1', latest: '0.9.0', status: 'outdated' })));

    expect(el.text()).toBe('v0.8.1 → 0.9.0');
    expect(el.attributes('data-state')).toBe('outdated');
    expect(el.attributes('title')).toContain('0.9.0');
  });

  test('a local build ahead of npm is marked, not flagged as an update', () => {
    const el = indicator(mountBar(state({ current: '0.9.0', latest: '0.8.1', status: 'ahead' })));

    expect(el.text()).toBe('v0.9.0');
    expect(el.attributes('data-state')).toBe('ahead');
    expect(el.attributes('title')).toContain('ahead of npm');
  });

  test('an unreachable registry still shows the running version', () => {
    const el = indicator(mountBar(state({ current: '0.8.1', latest: null, status: 'unknown' })));

    expect(el.text()).toBe('v0.8.1');
    expect(el.attributes('data-state')).toBe('unknown');
  });

  test('nothing is shown before the version loads', () => {
    expect(indicator(mountBar(null)).exists()).toBe(false);
  });

  test('nothing is shown when the daemon cannot read its own version', () => {
    const el = indicator(mountBar(state({ current: null, latest: '0.9.0', status: 'unknown' })));

    expect(el.exists()).toBe(false);
  });
});

describe('copying the update command', () => {
  function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(writeText) },
      configurable: true,
    });
    return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
  }

  test('a click copies the command for how the daemon was installed', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const el = indicator(
      mountBar(state({ current: '0.8.1', latest: '0.9.0', status: 'outdated' }, NPM_INSTALL))
    );

    await el.trigger('click');

    expect(writeText).toHaveBeenCalledWith('npm install -g diffstalkerd');
    expect(el.text()).toBe('copied');
  });

  test('the pacman command is whatever the daemon reported', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const el = indicator(
      mountBar(state({ current: '0.8.1', latest: '0.9.0', status: 'outdated' }, {
        method: 'pacman',
        package: 'diffstalker-git',
        command: 'yay -S diffstalker-git',
      }))
    );

    await el.trigger('click');

    expect(writeText).toHaveBeenCalledWith('yay -S diffstalker-git');
  });

  test('the command is named in the hover title and the chip is a button', () => {
    const el = indicator(
      mountBar(state({ current: '0.8.1', latest: '0.9.0', status: 'outdated' }, NPM_INSTALL))
    );

    expect(el.attributes('title')).toContain('npm install -g diffstalkerd');
    expect(el.attributes('role')).toBe('button');
    expect(el.classes()).toContain('copyable');
  });

  test('an install nothing owns just says what is running', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const el = indicator(mountBar(state({ current: '0.8.1', latest: '0.9.0', status: 'outdated' })));

    await el.trigger('click');

    expect(writeText).not.toHaveBeenCalled();
    expect(el.text()).toBe('v0.8.1 → 0.9.0');
    expect(el.attributes('title')).not.toContain('click to copy');
    expect(el.attributes('role')).toBeUndefined();
    expect(el.classes()).not.toContain('copyable');
  });

  test('a refused clipboard says so instead of doing nothing visible', async () => {
    stubClipboard(() => Promise.reject(new Error('not allowed')));
    const el = indicator(
      mountBar(state({ current: '0.8.1', latest: '0.9.0', status: 'outdated' }, NPM_INSTALL))
    );

    await el.trigger('click');
    await Promise.resolve();

    expect(el.text()).toBe('copy failed');
  });

  test('a stale bundle offers reload, not an update command', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    const daemon = useDaemonStore();
    daemon.servedBy = '0.8.1';
    const el = indicator(
      mountBar(state({ current: '0.9.0', latest: '0.9.0', status: 'current' }, NPM_INSTALL))
    );

    expect(el.attributes('data-state')).toBe('stale-bundle');
    await el.trigger('click');
    expect(writeText).not.toHaveBeenCalled();
  });
});
