/**
 * buildRepoRows unit tests: ordering, the three dedup layers, the section
 * eyebrows, filtering, and the reveal control's label.
 *
 * The component tests cover the same ground through the DOM where a wrong
 * click target could hide; these cover the combinations that would be
 * tedious to mount — a capped scan, a disconnected daemon, matching
 * positions — and pin the ORDER, which is the part a future change is most
 * likely to break without noticing.
 */

import { describe, test, expect } from 'vitest';
import { buildRepoRows, type OpenProject, type RecentProject } from './repoPickerRows';
import type { DiscoveredRepo, RepoSummary } from '@diffstalker/client';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function summary(id: string, path: string): RepoSummary {
  return { id, path, branch: 'main' };
}

function openProject(root: string, extra: Partial<OpenProject> = {}): OpenProject {
  return {
    root,
    name: root.split('/').at(-1) ?? root,
    repos: [summary(`id-${root}`, root)],
    worktreeCount: 1,
    familyPaths: [root],
    ...extra,
  };
}

function recentProject(root: string, extra: Partial<RecentProject> = {}): RecentProject {
  return {
    root,
    name: root.split('/').at(-1) ?? root,
    worktreeCount: 1,
    familyPaths: [root],
    openPath: root,
    ...extra,
  };
}

function discovered(path: string, extra: Partial<DiscoveredRepo> = {}): DiscoveredRepo {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    branch: 'main',
    lastActivity: NOW - DAY,
    ...extra,
  };
}

function build(input: Partial<Parameters<typeof buildRepoRows>[0]> = {}) {
  return buildRepoRows({
    openProjects: [],
    recentProjects: [],
    discovered: [],
    activeRepoId: null,
    query: '',
    expanded: false,
    connected: true,
    capped: false,
    now: NOW,
    ...input,
  });
}

/** Every row as "kind:key", which is the whole shape in one line. */
function shape(rows: ReturnType<typeof build>): string[] {
  return rows.map((row) => `${row.kind}:${row.key}`);
}

describe('sections and order', () => {
  test('open, then recent, then the reveal control', () => {
    const rows = build({
      openProjects: [openProject('/w/one')],
      recentProjects: [recentProject('/w/two')],
      discovered: [discovered('/w/three')],
    });

    expect(shape(rows)).toEqual([
      'section:section:Open',
      'open:open:/w/one',
      'section:section:Recent',
      'recent:recent:/w/two',
      'more:more',
    ]);
  });

  test('a lone section still gets its eyebrow', () => {
    // The OPEN label is what tells the reader these repos are already live
    // on the daemon; a single section is when that is least obvious.
    const rows = build({ openProjects: [openProject('/w/one')] });
    expect(rows[0]).toMatchObject({ kind: 'section', label: 'Open' });
  });

  test('each source keeps its own order — the filter never re-ranks', () => {
    // fzf would score "/w/bbb" above "/w/abbb" for the query "bbb". These
    // lists are ordered by recency and activity, which is worth more.
    const rows = build({
      recentProjects: [recentProject('/w/abbb'), recentProject('/w/bbb')],
      query: 'bbb',
    });
    expect(shape(rows)).toEqual([
      'section:section:Recent',
      'recent:recent:/w/abbb',
      'recent:recent:/w/bbb',
    ]);
  });
});

describe('dedup', () => {
  test('open beats recent for the same project root', () => {
    const rows = build({
      openProjects: [openProject('/w/calc')],
      recentProjects: [recentProject('/w/calc')],
    });
    expect(shape(rows)).toEqual(['section:section:Open', 'open:open:/w/calc']);
  });

  test('an open project hides every worktree of its family from discovered', () => {
    // The bare layout: discovery finds each sibling worktree as a repo of
    // its own, so only the FAMILY makes "one row per project" true.
    const rows = build({
      openProjects: [
        openProject('/w/calc', {
          worktreeCount: 2,
          familyPaths: ['/w/calc/main', '/w/calc/fix-a'],
          repos: [summary('r1', '/w/calc/main')],
        }),
      ],
      discovered: [
        discovered('/w/calc/main'),
        discovered('/w/calc/fix-a'),
        discovered('/w/other'),
      ],
      expanded: true,
    });

    expect(shape(rows)).toEqual([
      'section:section:Open',
      'open:open:/w/calc',
      'section:section:Discovered',
      'discovered:discovered:/w/other',
      'more:more',
    ]);
  });

  test('a recent project hides its family too', () => {
    const rows = build({
      recentProjects: [
        recentProject('/w/calc', { familyPaths: ['/w/calc/main'], openPath: '/w/calc/main' }),
      ],
      discovered: [discovered('/w/calc/main'), discovered('/w/other')],
      expanded: true,
    });
    expect(shape(rows).filter((row) => row.startsWith('discovered'))).toEqual([
      'discovered:discovered:/w/other',
    ]);
  });
});

describe('discovered visibility', () => {
  test('hidden until revealed, then listed under their own eyebrow', () => {
    const input = { discovered: [discovered('/w/one')] };
    expect(shape(build(input))).toEqual(['more:more']);
    expect(shape(build({ ...input, expanded: true }))).toEqual([
      'section:section:Discovered',
      'discovered:discovered:/w/one',
      'more:more',
    ]);
  });

  test('a query reaches them without revealing anything, and the control steps aside', () => {
    const rows = build({ discovered: [discovered('/w/one'), discovered('/w/two')], query: 'one' });
    expect(shape(rows)).toEqual(['section:section:Discovered', 'discovered:discovered:/w/one']);
  });

  test('the label counts what revealing will actually add', () => {
    // Two discovered repos, one of them already an open row: the control
    // must promise ONE, not two.
    const rows = build({
      openProjects: [openProject('/w/one')],
      discovered: [discovered('/w/one'), discovered('/w/two')],
    });
    expect(rows.at(-1)).toMatchObject({ kind: 'more', label: 'Show 1 discovered repos' });
  });

  test('a capped scan says the list is incomplete', () => {
    const rows = build({ discovered: [discovered('/w/one')], capped: true });
    expect(rows.at(-1)).toMatchObject({
      label: 'Show 1+ discovered repos (list incomplete)',
    });
  });

  test('a disconnected daemon hides the control, unless it is already expanded', () => {
    const input = { discovered: [discovered('/w/one')], connected: false };
    expect(shape(build(input))).toEqual([]);
    // Already expanded: hiding it would strand the user with no way back.
    expect(shape(build({ ...input, expanded: true })).at(-1)).toBe('more:more');
  });
});

describe('row content', () => {
  test('a discovered repo untouched for half a year reads as stale', () => {
    const [, fresh, stale] = build({
      discovered: [
        discovered('/w/fresh', { lastActivity: NOW - DAY }),
        discovered('/w/stale', { lastActivity: NOW - 200 * DAY }),
      ],
      expanded: true,
    });
    expect(fresh).toMatchObject({ stale: false });
    expect(stale).toMatchObject({ stale: true });
  });

  test('unknown activity counts as stale — it is not evidence of freshness', () => {
    const [, row] = build({
      discovered: [discovered('/w/unknown', { lastActivity: null })],
      expanded: true,
    });
    expect(row).toMatchObject({ stale: true });
  });

  test('the active project is the one holding the active repo id', () => {
    const [, row] = build({
      openProjects: [
        openProject('/w/calc', { repos: [summary('r1', '/w/calc/main'), summary('r2', '/w/calc/x')] }),
      ],
      activeRepoId: 'r2',
    });
    expect(row).toMatchObject({ kind: 'open', active: true });
  });

  test('matched characters are reported against the PATH the row draws', () => {
    const [, row] = build({ recentProjects: [recentProject('/w/archive')], query: 'arch' });
    if (row.kind !== 'recent') throw new Error('expected a recent row');
    expect([...row.positions].sort((a, b) => a - b).map((i) => row.path[i]).join('')).toBe('arch');
  });
});
