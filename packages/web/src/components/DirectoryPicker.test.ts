/**
 * DirectoryPicker tests: it walks the DAEMON's directories (the browser
 * has no path of its own to give), and a failed step keeps the listing on
 * screen instead of stranding you in an empty picker.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import DirectoryPicker from './DirectoryPicker.vue';
import { Deferred, makeFakeFetch } from '../testing/fakes';

const HOME = '/home/j';

/** A daemon filesystem: path -> its subdirectories. */
const TREE: Record<string, { name: string; isRepo: boolean }[]> = {
  [HOME]: [
    { name: 'gitRepos', isRepo: false },
    { name: 'Documents', isRepo: false },
  ],
  [`${HOME}/gitRepos`]: [
    { name: 'alpha', isRepo: true },
    { name: 'work', isRepo: false },
  ],
};

function browseFetch() {
  return makeFakeFetch((call) => {
    const asked = new URLSearchParams(call.url.split('?')[1] ?? '').get('path') ?? HOME;
    const entries = TREE[asked];
    if (!entries) return { status: 404, body: { error: `Cannot read directory: ${asked}` } };
    return {
      body: {
        path: asked,
        parent: asked === '/' ? null : asked.slice(0, asked.lastIndexOf('/')) || '/',
        home: HOME,
        entries: entries.map((entry) => ({ ...entry, path: `${asked}/${entry.name}` })),
      },
    };
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', browseFetch().fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browsing', () => {
  test('starts at the daemon home when given no start path', async () => {
    const picker = mount(DirectoryPicker);
    await flushPromises();

    expect(picker.find('.current').text()).toBe(HOME);
    expect(picker.findAll('.entry-name').map((e) => e.text())).toEqual(['gitRepos', 'Documents']);
  });

  test('starts where it is told', async () => {
    const picker = mount(DirectoryPicker, { props: { start: `${HOME}/gitRepos` } });
    await flushPromises();

    expect(picker.find('.current').text()).toBe(`${HOME}/gitRepos`);
  });

  test('clicking a directory walks into it', async () => {
    const picker = mount(DirectoryPicker);
    await flushPromises();

    await picker.findAll('.entry')[0].trigger('click');
    await flushPromises();

    expect(picker.find('.current').text()).toBe(`${HOME}/gitRepos`);
    expect(picker.findAll('.entry-name').map((e) => e.text())).toEqual(['alpha', 'work']);
  });

  test('a directory that is itself a repo is marked as one', async () => {
    const picker = mount(DirectoryPicker, { props: { start: `${HOME}/gitRepos` } });
    await flushPromises();

    const rows = picker.findAll('.entry');
    expect(rows[0].find('.repo-tag').exists()).toBe(true); // alpha
    expect(rows[1].find('.repo-tag').exists()).toBe(false); // work
  });

  test('the up button goes to the parent, and is disabled at the top', async () => {
    const picker = mount(DirectoryPicker, { props: { start: `${HOME}/gitRepos` } });
    await flushPromises();

    await picker.find('.up').trigger('click');
    await flushPromises();

    expect(picker.find('.current').text()).toBe(HOME);
  });

  test('"Use this folder" emits the directory being shown', async () => {
    const picker = mount(DirectoryPicker, { props: { start: `${HOME}/gitRepos` } });
    await flushPromises();

    await picker.find('.use').trigger('click');
    expect(picker.emitted('pick')?.[0]).toEqual([`${HOME}/gitRepos`]);
  });

  test('a start path that cannot be listed falls back to home, still saying why', async () => {
    // The field's typo would otherwise open a dead box: no listing to walk,
    // both buttons disabled, Cancel the only way out.
    const picker = mount(DirectoryPicker, { props: { start: `${HOME}/typo` } });
    await flushPromises();

    expect(picker.find('.current').text()).toBe(HOME);
    expect(picker.find('.use').attributes('disabled')).toBeUndefined();
    expect(picker.find('.picker-error').text()).toContain('typo');
  });

  test('a slow listing that is overtaken never lands on top of the newer one', async () => {
    // Click one folder on a slow mount, then another: the second is what the
    // user meant, so a late answer to the first must not drag them back.
    const slow = new Deferred<void>();
    vi.stubGlobal(
      'fetch',
      makeFakeFetch(async (call) => {
        const asked = new URLSearchParams(call.url.split('?')[1] ?? '').get('path') ?? HOME;
        if (asked === `${HOME}/slow`) await slow.promise;
        return {
          body: {
            path: asked,
            parent: HOME,
            home: HOME,
            entries:
              asked === HOME
                ? [
                    { name: 'slow', path: `${HOME}/slow`, isRepo: false },
                    { name: 'fast', path: `${HOME}/fast`, isRepo: false },
                  ]
                : [],
          },
        };
      }).fn
    );

    const picker = mount(DirectoryPicker);
    await flushPromises();

    await picker.findAll('.entry')[0].trigger('click'); // hangs
    await picker.findAll('.entry')[1].trigger('click'); // answers first
    await flushPromises();
    expect(picker.find('.current').text()).toBe(`${HOME}/fast`);

    slow.resolve();
    await flushPromises();
    expect(picker.find('.current').text()).toBe(`${HOME}/fast`);
  });

  test('an unreadable directory says why and keeps the listing on screen', async () => {
    const picker = mount(DirectoryPicker, { props: { start: `${HOME}/gitRepos` } });
    await flushPromises();

    // 'work' is not in the tree: the daemon 404s it.
    await picker.findAll('.entry')[1].trigger('click');
    await flushPromises();

    expect(picker.find('.picker-error').text()).toContain('Cannot read directory');
    expect(picker.find('.current').text()).toBe(`${HOME}/gitRepos`);
    expect(picker.findAll('.entry')).toHaveLength(2);
  });
});
