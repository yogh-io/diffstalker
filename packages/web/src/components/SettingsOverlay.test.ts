/**
 * SettingsOverlay tests: the watch-directory list is what the daemon
 * accepted, a refusal is shown next to the field and adds nothing, and
 * the panel distinguishes a root that failed to scan from an empty one.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SettingsOverlay from './SettingsOverlay.vue';
import { useSettingsStore } from '../stores/settings';
import { makeFakeFetch } from '../testing/fakes';

const ROOT = '/home/j/gitRepos';

/** A daemon that takes any save; discovery answers for whatever is saved. */
function fakeDaemon(repoCount = 2) {
  let watchRoots: string[] = [];
  return makeFakeFetch((call) => {
    if (call.url === '/settings' && call.method === 'PUT') {
      const body = call.body as { watchRoots: string[] };
      if (body.watchRoots.some((root) => !root.startsWith('/'))) {
        return { status: 400, body: { error: `Watch directory must be absolute: ${body.watchRoots.at(-1)}` } };
      }
      watchRoots = body.watchRoots;
      return { body: { watchRoots, persisted: true } };
    }
    if (call.url === '/settings') return { body: { watchRoots, persisted: true } };
    if (call.url.startsWith('/browse')) {
      const asked = new URLSearchParams(call.url.split('?')[1] ?? '').get('path') ?? '/home/j';
      return {
        body: {
          path: asked,
          parent: asked.slice(0, asked.lastIndexOf('/')) || '/',
          home: '/home/j',
          entries:
            asked === '/home/j'
              ? [{ name: 'gitRepos', path: '/home/j/gitRepos', isRepo: false }]
              : [],
        },
      };
    }
    if (call.url.startsWith('/discovered')) {
      return {
        body: {
          roots: watchRoots.map((path) => ({
            path,
            repos: Array.from({ length: repoCount }, (_, i) => ({
              path: `${path}/p${i}`,
              name: `p${i}`,
              branch: 'main',
              lastActivity: null,
            })),
            error: null,
            capped: false,
          })),
        },
      };
    }
    return { status: 404, body: {} };
  });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watch directories', () => {
  test('lists nothing, and says so, before any root is added', async () => {
    vi.stubGlobal('fetch', fakeDaemon().fn);
    const panel = mount(SettingsOverlay);
    await flushPromises();

    expect(panel.find('[data-testid="watch-roots"]').exists()).toBe(false);
    expect(panel.text()).toContain('No watch directories yet');
  });

  test('an added root is listed with the repo count the daemon found', async () => {
    vi.stubGlobal('fetch', fakeDaemon(3).fn);
    const panel = mount(SettingsOverlay);
    await flushPromises();

    await panel.find('#settings-new-root').setValue(ROOT);
    await panel.find('form.add-form').trigger('submit');
    await flushPromises();

    const rows = panel.find('[data-testid="watch-roots"]');
    expect(rows.text()).toContain(ROOT);
    expect(rows.text()).toContain('3 repos');
    // The field is cleared only when the save was taken.
    expect((panel.find('#settings-new-root').element as HTMLInputElement).value).toBe('');
  });

  test('a refused path shows the daemon reason and is not listed', async () => {
    vi.stubGlobal('fetch', fakeDaemon().fn);
    const panel = mount(SettingsOverlay);
    await flushPromises();

    await panel.find('#settings-new-root').setValue('relative/path');
    await panel.find('form.add-form').trigger('submit');
    await flushPromises();

    expect(panel.find('[data-testid="settings-error"]').text()).toContain('must be absolute');
    expect(panel.find('[data-testid="watch-roots"]').exists()).toBe(false);
    // Not cleared: the path is still there to fix.
    expect((panel.find('#settings-new-root').element as HTMLInputElement).value).toBe(
      'relative/path'
    );
  });

  test('removing a root drops its row', async () => {
    vi.stubGlobal('fetch', fakeDaemon().fn);
    const panel = mount(SettingsOverlay);
    await flushPromises();

    await panel.find('#settings-new-root').setValue(ROOT);
    await panel.find('form.add-form').trigger('submit');
    await flushPromises();

    await panel.find('.root-remove').trigger('click');
    await flushPromises();

    expect(panel.find('[data-testid="watch-roots"]').exists()).toBe(false);
  });

  test('a root the daemon could not scan shows its error, not a count', async () => {
    // A configured root whose directory is gone: the daemon keeps the
    // setting and reports the reason, so both must reach the panel.
    vi.stubGlobal(
      'fetch',
      makeFakeFetch((call) => {
        if (call.url === '/settings') return { body: { watchRoots: ['/gone'], persisted: true } };
        return {
          body: {
            roots: [
              { path: '/gone', repos: [], error: 'ENOENT: no such directory', capped: false },
            ],
          },
        };
      }).fn
    );
    const settings = useSettingsStore();
    await settings.load();

    const panel = mount(SettingsOverlay);
    await flushPromises();

    const row = panel.find('.root-status');
    expect(row.classes()).toContain('error');
    expect(row.text()).toContain('ENOENT');
  });

  test('says so when the daemon is not persisting settings', async () => {
    vi.stubGlobal('fetch', fakeDaemon().fn);
    const settings = useSettingsStore();
    settings.applySettings({ watchRoots: [], persisted: false });

    const panel = mount(SettingsOverlay);
    await flushPromises();

    expect(panel.text()).toContain('not saving settings to disk');
  });
});

describe('browsing for a directory', () => {
  test('picking a folder in the browser adds it, no typing involved', async () => {
    vi.stubGlobal('fetch', fakeDaemon().fn);
    const panel = mount(SettingsOverlay);
    await flushPromises();

    await panel.find('[data-testid="settings-browse"]').trigger('click');
    await flushPromises();
    expect(panel.find('[data-testid="directory-picker"]').exists()).toBe(true);

    // Walk into the listed folder, then take it.
    await panel.find('.entry').trigger('click');
    await flushPromises();
    await panel.find('.use').trigger('click');
    await flushPromises();

    expect(panel.find('[data-testid="watch-roots"]').text()).toContain('/home/j/gitRepos');
    // Taken: the picker closes itself.
    expect(panel.find('[data-testid="directory-picker"]').exists()).toBe(false);
  });

  test('Escape backs out of the browser, not out of the whole panel', async () => {
    vi.stubGlobal('fetch', fakeDaemon().fn);
    const panel = mount(SettingsOverlay);
    await flushPromises();

    await panel.find('[data-testid="settings-browse"]').trigger('click');
    await flushPromises();

    const dialog = panel.find('.overlay-dialog');
    await dialog.trigger('keydown', { key: 'Escape' });

    expect(panel.find('[data-testid="directory-picker"]').exists()).toBe(false);
    // The panel — and whatever was typed in the field — survives.
    expect(panel.find('[data-testid="settings-overlay"]').exists()).toBe(true);
  });

  test('a refused pick keeps the picker open with the reason', async () => {
    vi.stubGlobal(
      'fetch',
      makeFakeFetch((call) => {
        if (call.url === '/settings' && call.method === 'PUT') {
          return { status: 400, body: { error: 'No such directory: /home/j/gitRepos' } };
        }
        if (call.url === '/settings') return { body: { watchRoots: [], persisted: true } };
        if (call.url.startsWith('/browse')) {
          return {
            body: { path: '/home/j', parent: '/home', home: '/home/j', entries: [] },
          };
        }
        return { body: { roots: [] } };
      }).fn
    );
    const panel = mount(SettingsOverlay);
    await flushPromises();

    await panel.find('[data-testid="settings-browse"]').trigger('click');
    await flushPromises();
    await panel.find('.use').trigger('click');
    await flushPromises();

    expect(panel.find('[data-testid="directory-picker"]').exists()).toBe(true);
    expect(panel.find('[data-testid="settings-error"]').text()).toContain('No such directory');
  });
});

describe('freshness', () => {
  test('rescans when the panel opens, so branch labels are current', async () => {
    const fake = fakeDaemon();
    vi.stubGlobal('fetch', fake.fn);
    mount(SettingsOverlay);
    await flushPromises();

    expect(fake.callsTo('/discovered/rescan')).toHaveLength(1);
  });
});
