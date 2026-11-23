/**
 * PrDraftPanel tests: the suggestion's two states, the PR line, the
 * preview with placeholders marked and counted, and that draft text is
 * only ever text (an agent can write anything into these files).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrDraftPanel from './PrDraftPanel.vue';
import { useRepoStore } from '../stores/repo';
import { createDraftSession } from '../composables/draftSession';
import { makeFakeFetch } from '../testing/fakes';
import type { FakeFetch } from '../testing/fakes';
import type { BranchPr, PrDraft, PrInfo, PutDraftRequest } from '@diffstalker/core/types/work';
import panelSource from './PrDraftPanel.vue?raw';

let fake: FakeFetch;
let onDisk: PrDraft;
let prAnswer: BranchPr;

function draftOf(over: Partial<PrDraft> = {}): PrDraft {
  return {
    branch: 'main',
    top: null,
    suggested: null,
    ai: null,
    adoptedUnedited: false,
    version: 'absent',
    ...over,
  };
}

function openPr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 9087,
    title: 'Nginx in front',
    url: 'https://github.com/aerius/calculator/pull/9087',
    state: 'open',
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00Z',
    body: 'Old words',
    headRefName: 'main',
    headRefOid: 'a1b2c3',
    baseRefName: 'main',
    progress: null,
    headOwner: 'JornC',
    author: 'JornC',
    reviewRequested: false,
    repo: 'aerius/calculator',
    repoKey: 'aerius/calculator',
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  onDisk = draftOf();
  prAnswer = { pr: null, status: 'never', message: null, checkedAt: null, viewer: null };
  fake = makeFakeFetch((call) => {
    if (call.url === '/repos/r1/branches') return { body: [{ name: 'main', current: true }] };
    if (call.url.startsWith('/repos/r1/draft?')) return { body: onDisk };
    if (call.url === '/repos/r1/draft' && call.method === 'PUT') {
      onDisk = { ...onDisk, top: (call.body as PutDraftRequest).top, version: 'v2' };
      return { body: onDisk };
    }
    if (call.url.startsWith('/repos/r1/pr?')) return { body: prAnswer };
    if (call.url === '/repos/r1/draft/adopt') {
      onDisk = { ...onDisk, top: onDisk.suggested, version: 'v1', adoptedUnedited: true };
      return { body: onDisk };
    }
    if (call.url === '/work/prs/refresh') return { body: {} };
    if (call.url === '/repos/r1/pr/top') {
      prAnswer = { ...prAnswer, pr: openPr({ body: onDisk.top ?? '' }) };
      return { body: prAnswer };
    }
    return { status: 404, body: { error: 'no route' } };
  });
  vi.stubGlobal('fetch', fake.fn);
  const repo = useRepoStore();
  repo.repoId = 'r1';
  repo.repoPath = '/w/calc';
  repo.shared = {
    ...repo.shared,
    status: { files: [], branch: { current: 'main', ahead: 0, behind: 0 }, isRepo: true },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(PrDraftPanel);
  await flushPromises();
  return wrapper;
}

describe('suggestion', () => {
  test('with top.md empty it shows greyed with "start from this"', async () => {
    onDisk = draftOf({ suggested: 'Agent words' });
    const wrapper = await mountPanel();
    const box = wrapper.find('[data-testid="draft-suggestion"]');
    expect(box.element.tagName).toBe('SECTION');
    expect(box.text()).toContain('Agent words');

    await wrapper.find('[data-testid="draft-adopt"]').trigger('click');
    await flushPromises();
    expect(
      (wrapper.find('[data-testid="draft-editor"]').element as HTMLTextAreaElement).value
    ).toBe('Agent words');
    expect(wrapper.find('[data-testid="draft-save-line"]').text()).toBe('agent text, not edited');
  });

  test('with top.md written it sits collapsed below, with no button', async () => {
    onDisk = draftOf({ top: 'Mine', version: 'v1', suggested: 'Agent words' });
    const wrapper = await mountPanel();
    const box = wrapper.find('[data-testid="draft-suggestion"]');
    expect(box.element.tagName).toBe('DETAILS');
    expect((box.element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.find('[data-testid="draft-adopt"]').exists()).toBe(false);
  });

  test('no suggestion, no box', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="draft-suggestion"]').exists()).toBe(false);
  });
});

describe('preview', () => {
  test('placeholders are marked and counted, the AI zone composed below ---', async () => {
    onDisk = draftOf({
      top: 'Why {{nginx and not caddy?}} and {{link}}',
      version: 'v1',
      ai: '<details>notes</details>',
    });
    const wrapper = await mountPanel();
    const preview = wrapper.find('[data-testid="draft-preview"]');
    expect(preview.findAll('mark').map((m) => m.text())).toEqual([
      '{{nginx and not caddy?}}',
      '{{link}}',
    ]);
    expect(preview.text()).toBe(
      'Why {{nginx and not caddy?}} and {{link}}\n\n---\n<details>notes</details>'
    );
    expect(wrapper.find('[data-testid="draft-placeholder-count"]').text()).toBe('· 2 placeholders');
    expect(wrapper.find('[data-testid="draft-ai"]').element.tagName).toBe('DETAILS');
  });

  test('a <script> in a draft shows as text, never as markup', async () => {
    onDisk = draftOf({
      top: '<script>alert(1)</script><b>bold</b>',
      version: 'v1',
      ai: '<img src=x>',
    });
    const wrapper = await mountPanel();
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.find('b').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="draft-preview"]').text()).toContain(
      '<script>alert(1)</script>'
    );
    expect(panelSource).not.toMatch(/\sv-html=/);
  });
});

describe('the PR line', () => {
  test('never checked offers "check PRs"', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="draft-pr-line"]').text()).toContain('PR state not checked');
    await wrapper.find('[data-testid="draft-check-prs"]').trigger('click');
    await flushPromises();
    const refresh = fake.callsTo('/work/prs/refresh');
    expect(refresh).toHaveLength(1);
    expect(refresh[0].method).toBe('POST');
  });

  test('an open PR links out, and says when GitHub has other words', async () => {
    onDisk = draftOf({ top: 'New words', version: 'v1' });
    prAnswer = { pr: openPr(), status: 'ok', message: null, checkedAt: 1, viewer: 'JornC' };
    const wrapper = await mountPanel();
    const link = wrapper.find('[data-testid="draft-pr-line"] a');
    expect(link.text()).toBe('PR #9087');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(wrapper.find('[data-testid="draft-body-differs"]').exists()).toBe(true);
  });

  test('the same words on GitHub: nothing to say', async () => {
    onDisk = draftOf({ top: 'Old words', version: 'v1' });
    prAnswer = { pr: openPr(), status: 'ok', message: null, checkedAt: 1, viewer: 'JornC' };
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="draft-body-differs"]').exists()).toBe(false);
  });

  test('no top.md: the editor starts from the PR, and says so', async () => {
    prAnswer = { pr: openPr(), status: 'ok', message: null, checkedAt: 1, viewer: 'JornC' };
    const wrapper = await mountPanel();
    const editor = wrapper.find('[data-testid="draft-editor"]').element as HTMLTextAreaElement;
    expect(editor.value).toBe('Old words');
    expect(wrapper.find('[data-testid="draft-prefilled"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="draft-body-differs"]').exists()).toBe(false);
  });

  test('Update GitHub asks once more, then sends', async () => {
    onDisk = draftOf({ top: 'New words', version: 'v1' });
    prAnswer = { pr: openPr(), status: 'ok', message: null, checkedAt: 1, viewer: 'JornC' };
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="draft-github-top"]').text()).toBe('Old words');
    await wrapper.find('[data-testid="draft-push"]').trigger('click');
    expect(fake.callsTo('/repos/r1/pr/top')).toHaveLength(0);
    expect(wrapper.find('[data-testid="draft-push-confirm"]').text()).toContain('PR #9087');
    await wrapper.find('[data-testid="draft-push-yes"]').trigger('click');
    await flushPromises();
    expect(fake.callsTo('/repos/r1/pr/top')[0].body).toEqual({
      branch: 'main',
      version: 'v1',
      expectedTop: 'Old words',
    });
    expect(wrapper.find('[data-testid="draft-body-differs"]').exists()).toBe(false);
  });

  test('a placeholder in your words blocks Update GitHub', async () => {
    onDisk = draftOf({ top: 'Why {{reason}}', version: 'v1' });
    prAnswer = { pr: openPr(), status: 'ok', message: null, checkedAt: 1, viewer: 'JornC' };
    const wrapper = await mountPanel();
    const push = wrapper.find('[data-testid="draft-push"]');
    expect(push.attributes('disabled')).toBeDefined();
    expect(push.attributes('data-tip')).toContain('placeholders');
  });
});

test('a detached HEAD says there is no branch to draft for', async () => {
  const repo = useRepoStore();
  repo.shared = {
    ...repo.shared,
    status: { files: [], branch: { current: 'HEAD', ahead: 0, behind: 0 }, isRepo: true },
  };
  const wrapper = await mountPanel();
  expect(wrapper.find('[data-testid="draft-no-branch"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="draft-editor"]').exists()).toBe(false);
});

test("with a session it edits that session's branch and leaves the store alone", async () => {
  onDisk = draftOf({ branch: 'feature', top: 'Feature words', version: 'v1' });
  const session = createDraftSession(() => ({ id: 'r1', branch: 'feature' }));
  const wrapper = mount(PrDraftPanel, { props: { session } });
  await flushPromises();
  expect(wrapper.find('.panel-head').text()).toContain('feature');
  const editor = wrapper.find('[data-testid="draft-editor"]');
  expect((editor.element as HTMLTextAreaElement).value).toBe('Feature words');
  expect(wrapper.find('[data-testid="draft-no-branch"]').exists()).toBe(false);
  expect(fake.callsTo('/repos/r1/branches')).toHaveLength(0);

  await editor.setValue('Feature words, more');
  expect(session.text).toBe('Feature words, more');
  wrapper.unmount();
  expect(session.branch).toBe('feature');

  await session.dispose();
  expect(fake.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
    { branch: 'feature', top: 'Feature words, more', version: 'v1' },
  ]);
});
