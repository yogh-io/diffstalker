/**
 * WorkView tests: the sections, the shared columns, the repo groups, the
 * stage, review, CI and stack cells, the "last day" filter, the fold-out
 * (activity, facts, marks, the draft editor), the gh line for each
 * snapshot status, and timestamps rather than durations. A fake fetch
 * plays the daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorkView from './WorkView.vue';
import { formatFull } from '../utils/workFormat';
import { useUiStore } from '../stores/ui';
import { PREFS_KEY } from '../prefs';
import { useRepoStore } from '../stores/repo';
import { useDaemonStore } from '../stores/daemon';
import { useWorkStore } from '../stores/work';
import { makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FakeResponse, FetchCall } from '../testing/fakes';
import type { PrInfo, PrSnapshot, WorkMarks, WorkRepoFacts } from '@diffstalker/core/types/work';

const NOW = new Date(2026, 10, 23, 15, 0).getTime();
const CHECKED = new Date(2026, 10, 23, 14, 2).getTime();
const ROOT = '/w/calc';
const DAY = 24 * 60 * 60 * 1000;

function facts(): WorkRepoFacts {
  const worktree = {
    branch: 'main',
    head: 'h',
    isMain: true,
    isBare: false,
    lastActivity: NOW - DAY,
    changedAt: null,
    aheadOfBase: 0,
    base: 'upstream/main',
    uncommitted: 0,
  };
  return {
    path: ROOT,
    root: ROOT,
    name: 'calc',
    worktrees: [
      { ...worktree, path: ROOT },
      {
        ...worktree,
        path: '/w/calc-nginx',
        branch: 'nginx',
        isMain: false,
        uncommitted: 3,
        lastActivity: NOW - 5000,
      },
      {
        ...worktree,
        path: '/w/calc-pr',
        branch: 'with-pr',
        isMain: false,
        lastActivity: NOW - 6000,
      },
      { ...worktree, path: '/w/calc-old', branch: 'old', isMain: false, lastActivity: NOW - 7000 },
      {
        ...worktree,
        path: '/w/calc-stale',
        branch: 'stale',
        isMain: false,
        uncommitted: 1,
        lastActivity: NOW - 40 * DAY,
      },
    ],
    branches: [
      { name: 'main', tip: 'm', remoteCopy: true, unpushed: 0 },
      { name: 'nginx', tip: 'n', remoteCopy: true, unpushed: 2 },
      { name: 'with-pr', tip: 'p', remoteCopy: true, unpushed: 0 },
      { name: 'old', tip: 'o', remoteCopy: true, unpushed: 0 },
      { name: 'stale', tip: 's', remoteCopy: true, unpushed: 0 },
    ],
    branchesCapped: false,
    identities: ['aerius/calculator'],
    drafts: [],
  };
}

function pr(number: number, headRefName: string, over: Partial<PrInfo> = {}): PrInfo {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/aerius/calculator/pull/${number}`,
    state: 'open',
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: new Date(NOW - 1000).toISOString(),
    body: '',
    headRefName,
    headRefOid: `${headRefName}-head`,
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

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    status: 'ok',
    message: null,
    checkedAt: CHECKED,
    viewer: 'JornC',
    prs: [
      pr(9087, 'with-pr'),
      pr(12, 'old', { state: 'merged', mergedAt: new Date(2026, 10, 18, 9, 0).toISOString() }),
      pr(55, 'nowhere-local'),
    ],
    capped: false,
    ...over,
  };
}

let fake: FakeFetch;

/** The routes a fold-out's draft editor uses: open repo r1, its draft and PR, release. */
function draftRoute(call: FetchCall): FakeResponse {
  if (call.url === '/repos' && call.method === 'POST') {
    return { body: { id: 'r1', path: (call.body as { path: string }).path } };
  }
  if (call.url === '/repos/r1' && call.method === 'DELETE') return { body: {} };
  if (call.url.startsWith('/repos/r1/draft?')) {
    return {
      body: {
        branch: 'with-pr',
        top: 'My words',
        suggested: null,
        ai: null,
        adoptedUnedited: false,
        version: 'v1',
      },
    };
  }
  if (call.url.startsWith('/repos/r1/pr?')) {
    return {
      body: { pr: null, status: 'ok', message: null, checkedAt: CHECKED, viewer: 'JornC' },
    };
  }
  return { status: 404, body: { error: 'no route' } };
}
let prsAnswer: PrSnapshot;
let marks: WorkMarks;
/** Replaces the one watch directory that lists ROOT. */
let discoveryAnswer: unknown;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  setActivePinia(createPinia());
  prsAnswer = snapshot();
  marks = { tracked: {}, dismissed: {} };
  discoveryAnswer = null;
  fake = makeFakeFetch((call) => {
    if (call.url === '/discovered') {
      if (discoveryAnswer !== null) return { body: discoveryAnswer };
      return {
        body: {
          roots: [
            {
              path: '/w',
              repos: [{ path: ROOT, name: 'calc', branch: null, lastActivity: null }],
              error: null,
              capped: false,
            },
          ],
        },
      };
    }
    if (call.url === '/repos' && call.method === 'GET') return { body: [] };
    if (call.url === '/work/repo' && call.method === 'POST') return { body: facts() };
    if (call.url === '/work/prs') return { body: prsAnswer };
    if (call.url === '/work/prs/refresh') return { body: prsAnswer };
    if (call.url === '/work/marks') return { body: marks };
    return draftRoute(call);
  });
  vi.stubGlobal('fetch', fake.fn);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(WorkView);
  await flushPromises();
  return wrapper;
}

function rowsOf(wrapper: VueWrapper, section: string) {
  return wrapper
    .find(`[data-testid="work-section-${section}"]`)
    .findAll('[data-testid="work-row"]');
}

function branchesOf(wrapper: VueWrapper, section: string): string[] {
  return rowsOf(wrapper, section).map((row) => row.find('.branch').text());
}

/** Open or close a section the way a click on its summary does. */
async function setOpen(wrapper: VueWrapper, section: string, open: boolean): Promise<void> {
  const el = wrapper.find(`[data-testid="work-section-${section}"]`).element as HTMLDetailsElement;
  el.open = open;
  el.dispatchEvent(new Event('toggle'));
  await flushPromises();
}

function sectionOrder(wrapper: VueWrapper): Array<string | undefined> {
  return wrapper
    .findAll('[data-testid^="work-section-"]')
    .map((block) => block.attributes('data-testid'));
}

async function expand(row: ReturnType<typeof rowsOf>[number]): Promise<void> {
  await row.find('[data-testid="work-row-line"]').trigger('click');
  await flushPromises();
}

describe('sections', () => {
  test('work, candidates and done, each row with its stage and facts', async () => {
    const wrapper = await mountPage();
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    expect(rowsOf(wrapper, 'work')[0].find('[data-testid="work-stage"]').text()).toBe('in review');

    const candidate = rowsOf(wrapper, 'candidates');
    expect(candidate).toHaveLength(1);
    expect(candidate[0].find('.name').attributes('data-tip')).toContain('/w/calc-nginx');
    expect(candidate[0].find('[data-testid="work-stage"]').text()).toBe('local only');
    const local = candidate[0].find('[data-testid="work-local"]').text();
    expect(local).toContain('3');
    expect(local).toContain('↑2');

    const done = rowsOf(wrapper, 'done');
    expect(done[0].find('[data-testid="work-stage"]').text()).toBe('merged');
    expect(done[0].find('[data-testid="work-local"] .note').attributes('data-tip')).toBe(
      'worktree still on disk'
    );
    // Its worktree moved after the merge, so that is the newest activity.
    expect(done[0].find('[data-testid="work-status"]').text()).toBe('merged');
    expect(done[0].find('[data-testid="work-when"]').attributes('data-tip')).toContain(
      'commit or checkout'
    );
    expect(done[0].find('.when').text()).toBe('just now');
  });

  test('every row has one cell per column heading', async () => {
    const wrapper = await mountPage();
    const headings = wrapper.findAll('.col-heads > *').length;
    expect(headings).toBe(11);
    for (const row of wrapper.findAll('[data-testid="work-row-line"]')) {
      expect(row.findAll(':scope > .cell')).toHaveLength(headings);
    }
  });

  test('rows sit under a heading for their repo', async () => {
    const wrapper = await mountPage();
    const groups = wrapper
      .find('[data-testid="work-section-work"]')
      .findAll('[data-testid="work-group"]');
    expect(groups.map((group) => group.find('.group-name').text())).toEqual(['calc']);
    expect(groups[0].find('.group-count').text()).toBe('2');
  });

  test('older candidates sit folded right after Candidates', async () => {
    const wrapper = await mountPage();
    expect(sectionOrder(wrapper)).toEqual([
      'work-section-work',
      'work-section-candidates',
      'work-section-older',
      'work-section-done',
    ]);
    const older = wrapper.find('[data-testid="work-section-older"]');
    expect(older.element.tagName).toBe('DETAILS');
    expect(older.attributes('open')).toBeUndefined();
    expect(older.find('summary').text()).toBe('1 older candidate');
    expect(branchesOf(wrapper, 'older')).toEqual(['stale']);
  });

  test('with a time filter on, Done comes right after Work', async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="work-within-two-weeks"]').trigger('click');
    expect(sectionOrder(wrapper)).toEqual([
      'work-section-work',
      'work-section-done',
      'work-section-candidates',
    ]);
  });

  test('a section folds away, stays folded, and the browser remembers it', async () => {
    const wrapper = await mountPage();
    const done = () => wrapper.find('[data-testid="work-section-done"]');
    expect((done().element as HTMLDetailsElement).open).toBe(true);
    await setOpen(wrapper, 'done', false);
    expect(useUiStore().workFolded).toEqual(['done']);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').workFolded).toEqual(['done']);
    // A re-render keeps it folded; the heading still counts its rows.
    await wrapper.find('[data-testid="work-within-day"]').trigger('click');
    expect((done().element as HTMLDetailsElement).open).toBe(false);
    expect(done().find('summary').text()).toBe('Done 1');
  });

  test('a stored fold holds on the next visit', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ workFolded: ['work'] }));
    const wrapper = await mountPage();
    const section = wrapper.find('[data-testid="work-section-work"]');
    expect((section.element as HTMLDetailsElement).open).toBe(false);
    await setOpen(wrapper, 'work', true);
    expect(useUiStore().workFolded).toEqual([]);
  });

  test('folding Candidates takes the older candidates with it', async () => {
    const wrapper = await mountPage();
    await setOpen(wrapper, 'candidates', false);
    expect(wrapper.find('[data-testid="work-section-older"]').exists()).toBe(false);
    await setOpen(wrapper, 'candidates', true);
    expect(wrapper.find('[data-testid="work-section-older"]').exists()).toBe(true);
  });

  test('a watch directory that could not be read is named, not taken for no repos', async () => {
    discoveryAnswer = {
      roots: [{ path: '/mnt/work', repos: [], error: 'ENOENT: no such file', capped: false }],
    };
    const wrapper = await mountPage();
    const line = wrapper.find('[data-testid="work-root-errors"]');
    expect(line.text()).toBe('1 watch directory not fully scanned: work');
    expect(line.attributes('data-tip')).toBe('/mnt/work: ENOENT: no such file');
    expect(wrapper.find('[data-testid="work-no-repos"]').exists()).toBe(false);
  });
});

describe('cells', () => {
  test('the PR number is one click to GitHub; a PR with no local branch has no compare button', async () => {
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'work')[1];
    const link = row.find('[data-testid="work-pr-link"]');
    expect(link.attributes('href')).toBe('https://github.com/aerius/calculator/pull/55');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(row.find('[data-testid="work-local"]').text()).toBe('no branch');
    expect(row.find('[data-testid="work-compare"]').exists()).toBe(false);
    expect(rowsOf(wrapper, 'work')[0].find('[data-testid="work-compare"]').exists()).toBe(true);

    await link.trigger('click');
    expect(row.find('[data-testid="work-detail"]').exists()).toBe(false);
  });

  test('review, threads, CI and conflicts', async () => {
    prsAnswer = snapshot({
      prs: [
        pr(9087, 'with-pr', {
          progress: {
            decision: 'changes-requested',
            unresolvedThreads: 2,
            pendingReviewers: 0,
            requestedReviewers: [],
            changesRequestedBy: [],
            checks: 'failure',
            headCommittedAt: null,
            conflicting: true,
            events: [],
          },
        }),
      ],
    });
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'work')[0];
    expect(row.attributes('data-stage')).toBe('changes');
    const review = row.find('[data-testid="work-review"]');
    expect(review.find('[data-icon="changes"]').exists()).toBe(true);
    expect(review.text()).toBe('2');
    const checks = row.find('[data-testid="work-checks"]');
    expect(checks.find('[data-icon="cross"]').exists()).toBe(true);
    const conflicts = row.find('[data-testid="work-conflicts"]');
    expect(conflicts.text()).toBe('conflicts');
    expect(conflicts.attributes('data-tip')).toContain('merge conflicts with main');
  });

  test('no conflicts, no label', async () => {
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="work-conflicts"]').exists()).toBe(false);
  });

  test('a stack shows each layer as position of size, bottom first', async () => {
    prsAnswer = snapshot({
      prs: [pr(2, 's2', { baseRefName: 's1' }), pr(1, 's1'), pr(3, 's3', { baseRefName: 's2' })],
    });
    const wrapper = await mountPage();
    const stacks = rowsOf(wrapper, 'work').map((row) =>
      row.find('[data-testid="work-stack"]').text()
    );
    expect(stacks).toEqual(['1/3', '2/3', '3/3']);
  });

  test('the status says approved, and the When hover names who and what', async () => {
    const at = new Date(NOW - 1000).toISOString();
    prsAnswer = snapshot({
      prs: [
        pr(9087, 'with-pr', {
          progress: {
            decision: null,
            unresolvedThreads: 0,
            pendingReviewers: 0,
            requestedReviewers: [],
            changesRequestedBy: [],
            checks: null,
            headCommittedAt: null,
            conflicting: false,
            events: [{ kind: 'approved', author: 'Bert', at }],
          },
        }),
      ],
    });
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'work')[0];
    expect(row.find('[data-testid="work-when"]').attributes('data-tip')).toContain(
      'approved · Bert'
    );
    const cell = row.find('[data-testid="work-status"]');
    expect(cell.text()).toBe('approved');
    expect(cell.classes()).toContain('you');
  });
});

describe('who waits on the author', () => {
  test('changes requested and not asked again: an alert, with the reason on hover', async () => {
    prsAnswer = snapshot({
      prs: [
        pr(9087, 'with-pr', {
          progress: {
            decision: 'changes-requested',
            unresolvedThreads: 0,
            pendingReviewers: 0,
            requestedReviewers: [],
            changesRequestedBy: ['Bert'],
            checks: null,
            headCommittedAt: null,
            conflicting: false,
            events: [],
          },
        }),
      ],
    });
    const wrapper = await mountPage();
    const alert = rowsOf(wrapper, 'work')[0].find('[data-testid="work-attention"]');
    expect(alert.attributes('data-tip')).toBe(
      'Changes requested by Bert, not asked to review again yet'
    );
  });

  test('a review request: work by its author, with an alert and a copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    prsAnswer = snapshot({
      prs: [
        ...snapshot().prs,
        pr(752, 'their-branch', {
          author: 'SerhatG',
          headOwner: 'SerhatG',
          reviewRequested: true,
        }),
      ],
    });
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'work').find((r) => r.find('.branch').text() === 'their-branch')!;
    expect(row.find('[data-testid="work-track"]').exists()).toBe(false);
    expect(row.find('[data-testid="work-by"]').text()).toBe('by SerhatG');
    expect(row.find('[data-testid="work-attention"]').attributes('data-tip')).toBe(
      'SerhatG asks you to review this'
    );
    await row.find('[data-testid="work-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain(
      'Pull request: https://github.com/aerius/calculator/pull/752'
    );
    expect(row.find('[data-testid="work-copy"]').attributes('data-tip')).toBe('Copied');
    const mine = rowsOf(wrapper, 'work').find((r) => r.find('.branch').text() !== 'their-branch')!;
    expect(mine.find('[data-testid="work-attention"]').exists()).toBe(false);
  });
});

describe('sorting by a column', () => {
  test('sorts inside each repo; a second click reverses, a third goes back', async () => {
    const wrapper = await mountPage();
    const prHead = () =>
      wrapper
        .findAll('[data-testid="work-col-heads"] button')
        .find((b) => b.text().startsWith('PR'))!;
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    await prHead().trigger('click');
    expect(branchesOf(wrapper, 'work')).toEqual(['nowhere-local', 'with-pr']);
    expect(prHead().attributes('aria-sort')).toBe('ascending');
    expect(prHead().text()).toBe('PR ↑');
    await prHead().trigger('click');
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    expect(prHead().attributes('aria-sort')).toBe('descending');
    await prHead().trigger('click');
    expect(prHead().attributes('aria-sort')).toBeUndefined();
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    expect(wrapper.find('[data-testid="work-section-work"]').exists()).toBe(true);
  });
});

describe('the time filter', () => {
  test('keeps only what moved in the window, in every section; All brings the rest back', async () => {
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="work-within-day"]').text()).toBe('Last day 3');
    expect(wrapper.find('[data-testid="work-within-month"]').text()).toBe('Last month 3');
    await wrapper.find('[data-testid="work-within-day"]').trigger('click');
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr']);
    expect(branchesOf(wrapper, 'candidates')).toEqual(['nginx']);
    expect(branchesOf(wrapper, 'done')).toEqual(['old']);
    expect(wrapper.find('[data-testid="work-section-older"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="work-within-day"]').attributes('aria-pressed')).toBe('true');

    await wrapper.find('[data-testid="work-within-all"]').trigger('click');
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    expect(branchesOf(wrapper, 'older')).toEqual(['stale']);
  });

  test('the browser remembers the filter for the next visit', async () => {
    const first = await mountPage();
    await first.find('[data-testid="work-within-day"]').trigger('click');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').workWithin).toBe('day');
    first.unmount();

    setActivePinia(createPinia());
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="work-within-day"]').attributes('aria-pressed')).toBe('true');
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr']);
    await wrapper.find('[data-testid="work-within-all"]').trigger('click');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').workWithin).toBeNull();
  });

  test('a PR with no local branch and only bot comments counts its head commit', async () => {
    prsAnswer = snapshot({
      prs: [
        pr(9087, 'with-pr'),
        pr(55, 'nowhere-local', {
          progress: {
            decision: null,
            unresolvedThreads: 0,
            pendingReviewers: 0,
            requestedReviewers: [],
            changesRequestedBy: [],
            checks: 'success',
            headCommittedAt: new Date(NOW - 3 * DAY).toISOString(),
            conflicting: false,
            events: [],
          },
        }),
      ],
    });
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="work-within-week"]').trigger('click');
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    await wrapper.find('[data-testid="work-within-day"]').trigger('click');
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr']);
  });

  test('a window with nothing in it says so, not "nothing open"', async () => {
    vi.setSystemTime(NOW + 400 * DAY);
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="work-within-month"]').text()).toBe('Last month 0');
    await wrapper.find('[data-testid="work-within-month"]').trigger('click');
    expect(wrapper.find('[data-testid="work-within-empty"]').text()).toBe(
      'Nothing moved in the last month.'
    );
    expect(wrapper.find('[data-testid="work-clear"]').exists()).toBe(false);
  });
});

describe('grouping', () => {
  test('by repository off: one plain list; by time on: last day, last week and older', async () => {
    const wrapper = await mountPage();
    expect(wrapper.findAll('[data-testid="work-group"]').length).toBeGreaterThan(0);
    await wrapper.find('[data-testid="work-by-repo"]').trigger('click');
    expect(wrapper.find('[data-testid="work-group"]').exists()).toBe(false);
    expect(branchesOf(wrapper, 'work')).toEqual(['with-pr', 'nowhere-local']);
    expect(useUiStore().workByRepo).toBe(false);

    await wrapper.find('[data-testid="work-by-time"]').trigger('click');
    const heads = wrapper
      .find('[data-testid="work-section-work"]')
      .findAll('[data-testid="work-time"]')
      .map((head) => head.find('.time-name').text());
    expect(heads).toEqual(['Last day', 'Older']);
    expect(wrapper.find('[data-testid="work-by-time"]').attributes('aria-pressed')).toBe('true');
  });

  test('both on: repo headings inside each time heading', async () => {
    useUiStore().toggleWorkByTime();
    const wrapper = await mountPage();
    const section = wrapper.find('[data-testid="work-section-work"]');
    const order = section
      .findAll('li')
      .filter((li) => ['work-time', 'work-group'].includes(li.attributes('data-testid') ?? ''))
      .map((li) =>
        li
          .findAll('span')
          .map((span) => span.text())
          .join(' ')
      );
    expect(order).toEqual(['Last day 1', 'calc 1', 'Older 1', 'calc 1']);
  });
});

describe('the gh line', () => {
  test('ok: how long ago and as whom, the time on hover', async () => {
    const wrapper = await mountPage();
    const line = wrapper.find('[data-testid="gh-line"]');
    expect(line.text()).toBe('PRs checked 58 minutes ago as JornC');
    expect(line.attributes('data-tip')).toBe(formatFull(CHECKED));
  });

  test.each([
    ['gh-missing', null, 'gh not found — PR state unknown'],
    ['gh-logged-out', null, 'gh not logged in — PR state unknown'],
    ['error', 'timeout', 'could not reach GitHub: timeout'],
  ] as const)('%s', async (status, message, text) => {
    prsAnswer = snapshot({ status, message, checkedAt: null, viewer: null, prs: [] });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="gh-line"]').text()).toBe(text);
  });

  test('a failed refresh shows the notice and when the kept list was read', async () => {
    prsAnswer = snapshot({ status: 'error', message: 'timeout' });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="gh-line"]').text()).toBe(
      'could not reach GitHub: timeout · PRs checked 58 minutes ago as JornC'
    );
  });

  test('the scan line says how long ago the repos were scanned', async () => {
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="scan-line"]').text()).toBe('Repos scanned just now');
  });

  test('shown again, the page catches up', async () => {
    const wrapper = await mountPage();
    const catchUp = vi.spyOn(useWorkStore(), 'catchUp').mockResolvedValue();
    window.dispatchEvent(new Event('focus'));
    expect(catchUp).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    window.dispatchEvent(new Event('focus'));
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  test('never asked: the page asks once on open', async () => {
    prsAnswer = snapshot({ status: 'never', checkedAt: null, viewer: null, prs: [] });
    await mountPage();
    expect(fake.callsTo('/work/prs/refresh')).toHaveLength(1);
  });

  test('an item time reads as how long ago, the date and time on hover', async () => {
    const wrapper = await mountPage();
    const when = rowsOf(wrapper, 'older')[0].find('.when');
    expect(when.text()).toBe('1 month 10 days ago');
    expect(when.attributes('data-tip')).toContain(formatFull(NOW - 40 * DAY));
    expect(wrapper.find('[title]').exists()).toBe(false);
  });
});

describe('the fold-out', () => {
  function markPuts() {
    return fake.calls
      .filter((c) => c.url === '/work/marks' && c.method === 'PUT')
      .map((c) => c.body);
  }

  test('a click on the row opens it: activity and facts; a second click closes it', async () => {
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'candidates')[0];
    await expand(row);
    const detail = row.find('[data-testid="work-detail"]');
    expect(detail.text()).toContain('commit or checkout');
    expect(detail.text()).toContain('/w/calc-nginx');
    expect(detail.text()).toContain('3 uncommitted, 2 unpushed');
    await expand(row);
    expect(row.find('[data-testid="work-detail"]').exists()).toBe(false);
  });

  test('Track on the row and Dismiss in the fold-out call the store', async () => {
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'candidates')[0];
    await row.find('[data-testid="work-track"]').trigger('click');
    expect(row.find('[data-testid="work-detail"]').exists()).toBe(false);
    await expand(row);
    expect(row.find('[data-testid="work-drop"]').exists()).toBe(false);
    await row.find('[data-testid="work-dismiss"]').trigger('click');
    await flushPromises();
    expect(markPuts()).toEqual([
      { key: `${ROOT}\nnginx`, action: 'track' },
      { key: `${ROOT}\nnginx`, action: 'dismiss', fingerprint: 'n|1|0' },
    ]);
  });

  test('a tracked item has Stop tracking, and no Track', async () => {
    marks = { tracked: { [`${ROOT}\nnginx`]: { at: 1 } }, dismissed: {} };
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'work').find((r) => r.find('.branch').text() === 'nginx')!;
    expect(row.find('[data-testid="work-track"]').exists()).toBe(false);
    await expand(row);
    await row.find('[data-testid="work-drop"]').trigger('click');
    await flushPromises();
    expect(markPuts()).toEqual([{ key: `${ROOT}\nnginx`, action: 'drop' }]);
  });

  test('a dismissed item sits in the disclosure and can be shown again', async () => {
    marks = { tracked: {}, dismissed: { [`${ROOT}\nnginx`]: { fingerprint: 'n|1|0', at: 1 } } };
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="work-section-candidates"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="work-dismissed"] summary').text()).toBe('1 dismissed');
    await wrapper.find('[data-testid="work-undismiss"]').trigger('click');
    await flushPromises();
    expect(markPuts()).toEqual([{ key: `${ROOT}\nnginx`, action: 'undismiss' }]);
  });

  test("edits the branch's draft, and lets the repo go when closed", async () => {
    const wrapper = await mountPage();
    const row = rowsOf(wrapper, 'work')[0];
    await expand(row);
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos')[0].body).toEqual({
      path: '/w/calc-pr',
    });
    const editor = row.find('[data-testid="work-detail"] textarea');
    expect((editor.element as HTMLTextAreaElement).value).toBe('My words');

    await expand(row);
    await flushPromises();
    expect(fake.calls.filter((c) => c.method === 'DELETE' && c.url === '/repos/r1')).toHaveLength(
      1
    );
  });
});

describe('opening a row in Compare', () => {
  test('the compare button opens Compare in the worktree and closes the page', async () => {
    const wrapper = await mountPage();
    const ui = useUiStore();
    const repo = useRepoStore();
    const daemon = useDaemonStore();
    ui.openWork();
    // The repo is already the active one, so nothing is re-opened.
    daemon.repos = [{ id: 'r9', path: '/w/calc-pr', branch: 'with-pr' }];
    daemon.activeRepoId = 'r9';
    repo.repoId = 'r9';
    repo.repoPath = '/w/calc-pr';
    const pick = vi.spyOn(repo, 'setComparePick').mockResolvedValue();

    await rowsOf(wrapper, 'work')[0].find('[data-testid="work-compare"]').trigger('click');
    await flushPromises();
    expect(ui.workOpen).toBe(false);
    expect(ui.activeView).toBe('compare');
    expect(pick).toHaveBeenCalledWith({ head: null });
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos')).toHaveLength(0);
  });
});
