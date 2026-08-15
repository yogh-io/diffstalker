import { describe, expect, test } from 'bun:test';
import {
  buildUrlPath,
  encodeQueryValue,
  isViewName,
  parseUrl,
  readQuery,
  repoSegments,
} from './urlGrammar';

const HOME = '/home/jorn';

describe('parseUrl', () => {
  test('reads view, home-relative repo, and anchor', () => {
    const state = parseUrl('/changes/~/gitRepos/diffstalker', '?at=u:src/App.vue');
    expect(state.view).toBe('changes');
    expect(state.repo).toEqual({ homeRelative: true, path: 'gitRepos/diffstalker' });
    expect(state.at).toBe('u:src/App.vue');
    expect(state.base).toBeNull();
  });

  test('an absolute repo path has no sentinel', () => {
    const state = parseUrl('/explorer/srv/git/thing', '?at=a.ts');
    expect(state.repo).toEqual({ homeRelative: false, path: 'srv/git/thing' });
  });

  test('a path that is not view-first names no place', () => {
    // The failure mode this grammar exists to prevent: a repo-first URL (the
    // old shape) must resolve to nothing rather than to a wrong place.
    expect(parseUrl('/gitRepos/diffstalker/changes').view).toBeNull();
    expect(parseUrl('/').view).toBeNull();
    expect(parseUrl('/health').view).toBeNull();
  });

  test('a malformed escape yields raw text instead of throwing', () => {
    expect(() => parseUrl('/explorer/~/a%zz')).not.toThrow();
    expect(parseUrl('/explorer/~/a%zz').repo?.path).toBe('a%zz');
  });

  test('readQuery keeps a + in a filename (URLSearchParams would eat it)', () => {
    expect(readQuery('?at=a+b.ts').get('at')).toBe('a+b.ts');
  });
});

describe('buildUrlPath', () => {
  test('home-relative repo collapses to the sentinel', () => {
    expect(buildUrlPath({ view: 'journal', repoPath: `${HOME}/gitRepos/x`, home: HOME })).toBe(
      '/journal/~/gitRepos/x'
    );
  });

  test('a repo outside $HOME stays absolute', () => {
    expect(buildUrlPath({ view: 'journal', repoPath: '/srv/git/x', home: HOME })).toBe(
      '/journal/srv/git/x'
    );
  });

  test('no repo is the root', () => {
    expect(buildUrlPath({ view: 'changes', repoPath: null })).toBe('/');
  });

  test('base comes before at, matching what the web writes', () => {
    // If the order differed, a link and the URL the app rewrites after
    // landing on it would not be byte-equal, and the app would push a
    // second history entry for arriving where it already was.
    expect(
      buildUrlPath({ view: 'compare', repoPath: '/r', home: null, at: 'a.ts', base: 'main' })
    ).toBe('/compare/r?base=main&at=a.ts');
  });

  test('a directory literally named ~ is escaped, not read as the sentinel', () => {
    // encodeURIComponent leaves `~` alone (it is unreserved), so this has
    // to be escaped by hand — otherwise /~/x reads back as $HOME/x.
    const url = buildUrlPath({ view: 'explorer', repoPath: '/~/x', home: HOME });
    expect(url).toBe('/explorer/%7E/x');
    expect(parseUrl(url).repo).toEqual({ homeRelative: false, path: '~/x' });
  });
});

describe('round trip', () => {
  // The property that keeps `diffstalker link` and the web client honest: a
  // URL one side writes is a URL the other side reads back to the SAME
  // place. A drift here does not error, it silently lands elsewhere.
  const anchors = [
    'src/App.vue',
    'u:src/App.vue',
    'a file with spaces.ts',
    'weird/name+plus.ts',
    'pct%20literal.ts',
    'amp&and.ts',
    'hash#in-name.ts',
    'question?mark.ts',
  ];

  for (const at of anchors) {
    test(`anchor ${at}`, () => {
      const url = buildUrlPath({ view: 'explorer', repoPath: `${HOME}/r`, home: HOME, at });
      const [pathname, search] = url.split(/(?=\?)/);
      const state = parseUrl(pathname, search ?? '');
      expect(state.view).toBe('explorer');
      expect(state.repo).toEqual({ homeRelative: true, path: 'r' });
      expect(state.at).toBe(at);
    });
  }

  const repoPaths = [`${HOME}/gitRepos/diffstalker`, '/srv/git/x', `${HOME}/a b/c+d`, '/srv/100%'];

  for (const repoPath of repoPaths) {
    test(`repo ${repoPath}`, () => {
      const url = buildUrlPath({ view: 'changes', repoPath, home: HOME });
      const state = parseUrl(url);
      expect(state.repo).not.toBeNull();
      const abs = state.repo!.homeRelative
        ? `${HOME}/${state.repo!.path}`
        : `/${state.repo!.path}`;
      expect(abs).toBe(repoPath);
    });
  }
});

describe('encoding helpers', () => {
  test('encodeQueryValue leaves / and : readable', () => {
    expect(encodeQueryValue('u:src/App.vue')).toBe('u:src/App.vue');
  });

  test('encodeQueryValue escapes what would break the query', () => {
    expect(encodeQueryValue('a&b=c')).toBe('a%26b%3Dc');
  });

  test('repoSegments treats a prefix match that is not a path boundary as outside', () => {
    // /home/jornsen is not under /home/jorn.
    expect(repoSegments('/home/jornsen/x', HOME)).toEqual(['home', 'jornsen', 'x']);
  });

  test('the home directory itself is the bare sentinel', () => {
    expect(repoSegments(HOME, HOME)).toEqual(['~']);
  });

  test('isViewName covers exactly the five views', () => {
    for (const name of ['changes', 'journal', 'history', 'compare', 'explorer']) {
      expect(isViewName(name)).toBe(true);
    }
    expect(isViewName('blame')).toBe(false);
    expect(isViewName(undefined)).toBe(false);
  });
});

describe('whole=1 — the anchored file drawn in full', () => {
  test('parses, and defaults to false when absent', () => {
    expect(parseUrl('/changes/~/w/ds', '?at=u:a.ts').whole).toBe(false);
    expect(parseUrl('/changes/~/w/ds', '?whole=1&at=u:a.ts').whole).toBe(true);
  });

  test('reaches the repo-less early return too', () => {
    // The two returns in parseUrl are easy to update by halves; a view
    // with no repo segments must still carry the flag.
    expect(parseUrl('/changes', '?whole=1').whole).toBe(true);
  });

  test('only the literal 1 is on — there is no third state to encode', () => {
    expect(parseUrl('/changes/~/w/ds', '?whole=true').whole).toBe(false);
    expect(parseUrl('/changes/~/w/ds', '?whole=0').whole).toBe(false);
    expect(parseUrl('/changes/~/w/ds', '?whole=').whole).toBe(false);
  });

  test('writes at a PINNED position: base, whole, at', () => {
    // Order is load-bearing: writeUrl compares path+search as a STRING,
    // so a differently ordered URL never compares equal and would be
    // rewritten on the first write after landing on a shared link.
    expect(
      buildUrlPath({
        view: 'changes',
        repoPath: '/home/j/w/ds',
        home: '/home/j',
        at: 'u:a.ts',
        base: 'origin/main',
        whole: true,
      })
    ).toBe('/changes/~/w/ds?base=origin/main&whole=1&at=u:a.ts');
  });

  test('omitted and false both write nothing', () => {
    const place = { view: 'changes' as const, repoPath: '/home/j/w/ds', home: '/home/j', at: 'u:a.ts' };
    expect(buildUrlPath(place)).toBe('/changes/~/w/ds?at=u:a.ts');
    expect(buildUrlPath({ ...place, whole: false })).toBe('/changes/~/w/ds?at=u:a.ts');
  });

  test('round-trips: what buildUrlPath writes, parseUrl reads back', () => {
    const url = buildUrlPath({
      view: 'changes',
      repoPath: '/home/j/w/ds',
      home: '/home/j',
      at: 'u:src/a b+c.ts',
      whole: true,
    });
    const [pathname, search] = url.split('?');
    const back = parseUrl(pathname, `?${search}`);
    expect(back.whole).toBe(true);
    expect(back.at).toBe('u:src/a b+c.ts');
  });
});
