import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getStack, STACK_WALK_LIMIT } from './stack.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

/** One commit touching `file`, so every layer has a real change. */
function commit(repoPath: string, file: string, message: string): string {
  writeFixtureFile(repoPath, file, `${message}\n`);
  gitExec(repoPath, `add ${file}`);
  gitExec(repoPath, `commit -m "${message}"`);
  return gitExec(repoPath, 'rev-parse HEAD').trim();
}

/** The compact shape the tests compare: name, commits, isHead per layer. */
function outline(layers: { name: string; commits: number; isHead: boolean }[]): string[] {
  return layers.map((l) => `${l.name}:${l.commits}${l.isHead ? '*' : ''}`);
}

describe('getStack (fixture)', () => {
  const REPO_NAME = 'stack-test';
  let repoPath: string;
  let tips: Record<string, string>;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    tips = {};
    commit(repoPath, 'base.txt', 'base');
    // The trunk is a remote-tracking ref, as it is in real use. A branch
    // merged into it must never be a layer.
    gitExec(repoPath, 'checkout -b merged');
    commit(repoPath, 'merged.txt', 'merged work');
    gitExec(repoPath, 'checkout main');
    gitExec(repoPath, 'merge --ff-only merged');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/main main');
    gitExec(repoPath, 'symbolic-ref refs/remotes/upstream/HEAD refs/remotes/upstream/main');

    // A three-layer stack: bottom (1 commit), middle (2), top (1). Each
    // layer also has a remote-tracking copy at the same tip.
    gitExec(repoPath, 'checkout -b bottom');
    tips.bottom = commit(repoPath, 'bottom.txt', 'bottom');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/bottom bottom');
    gitExec(repoPath, 'checkout -b middle');
    commit(repoPath, 'middle.txt', 'middle one');
    tips.middle = commit(repoPath, 'middle.txt', 'middle two');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/middle middle');
    gitExec(repoPath, 'checkout -b top');
    tips.top = commit(repoPath, 'top.txt', 'top');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/top top');

    // A side branch off main that is NOT on the stack's line: never a layer.
    gitExec(repoPath, 'checkout -b side main');
    commit(repoPath, 'side.txt', 'side work');

    // An orphan root with no history in common with trunk.
    gitExec(repoPath, 'checkout --orphan orphan');
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "orphan root"');

    gitExec(repoPath, 'checkout top');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  it('lists the stack bottom to top from the top, with per-layer commit counts', async () => {
    const stack = await getStack(repoPath, 'upstream/main');
    expect(stack.trunk).toBe('upstream/main');
    expect(stack.forkedAbove).toBe(false);
    expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2', 'top:1*']);
    expect(stack.layers.map((l) => l.tip)).toEqual([tips.bottom, tips.middle, tips.top]);
  });

  it('groups the local branch and its remote-tracking copy into one layer, local first', async () => {
    const stack = await getStack(repoPath, 'upstream/main');
    expect(stack.layers.map((l) => l.refs)).toEqual([
      ['bottom', 'upstream/bottom'],
      ['middle', 'upstream/middle'],
      ['top', 'upstream/top'],
    ]);
  });

  it('never lists a branch merged into trunk, a side branch, or the upstream/HEAD symref', async () => {
    const stack = await getStack(repoPath, 'upstream/main');
    const refs = stack.layers.flatMap((l) => l.refs);
    expect(refs).not.toContain('merged');
    expect(refs).not.toContain('side');
    expect(refs).not.toContain('upstream/HEAD');
    expect(refs).not.toContain('upstream/main');
  });

  it('from the middle, the layers above HEAD follow as one chain', async () => {
    gitExec(repoPath, 'checkout middle');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2*', 'top:1']);
      expect(stack.forkedAbove).toBe(false);
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });

  it('from the bottom, every other layer is above HEAD', async () => {
    gitExec(repoPath, 'checkout bottom');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1*', 'middle:2', 'top:1']);
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });

  it('a fork above HEAD drops those layers and says so', async () => {
    // A second branch on top of middle, beside top: from middle there are
    // two tips above HEAD that neither reach the other.
    gitExec(repoPath, 'checkout -b top-b middle');
    commit(repoPath, 'top-b.txt', 'top b');
    gitExec(repoPath, 'checkout middle');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2*']);
      expect(stack.forkedAbove).toBe(true);

      // From top itself the fork is beside HEAD, not above it: unaffected.
      gitExec(repoPath, 'checkout top');
      const fromTop = await getStack(repoPath, 'upstream/main');
      expect(outline(fromTop.layers)).toEqual(['bottom:1', 'middle:2', 'top:1*']);
      expect(fromTop.forkedAbove).toBe(false);
    } finally {
      gitExec(repoPath, 'checkout top');
      gitExec(repoPath, 'branch -D top-b');
    }
  });

  it('a detached HEAD past the last branch is a layer named HEAD', async () => {
    gitExec(repoPath, 'checkout --detach top');
    const detachedTip = commit(repoPath, 'detached.txt', 'past top');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2', 'top:1', 'HEAD:1*']);
      const head = stack.layers.at(-1)!;
      expect(head).toMatchObject({ refs: [], tip: detachedTip });
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });

  it('a detached HEAD at a branch tip is that branch', async () => {
    gitExec(repoPath, 'checkout --detach middle');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2*', 'top:1']);
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });

  it('the HEAD layer is named after the checked-out branch, not the first local name at its tip', async () => {
    // Two local branches at HEAD's tip: `aaa` sorts first, but `top` is
    // what the user checked out and what the strip must call the layer.
    gitExec(repoPath, 'branch aaa top');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(stack.layers.at(-1)).toMatchObject({
        name: 'top',
        refs: ['aaa', 'top', 'upstream/top'],
        isHead: true,
      });
    } finally {
      gitExec(repoPath, 'branch -D aaa');
    }
  });

  it('HEAD at the trunk is one empty layer, never a stack', async () => {
    gitExec(repoPath, 'checkout main');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['main:0*']);
      expect(stack.layers[0].refs).toEqual([]);
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });

  it('a flag-shaped ref at a tip is never the layer name while another ref is there', async () => {
    // `-dash` sorts before every letter, so without the rule it would be
    // the name — and the name travels as ?head=, which refuses a dash.
    gitExec(repoPath, 'update-ref refs/heads/-dash middle');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(stack.layers[1]).toMatchObject({
        name: 'middle',
        refs: ['-dash', 'middle', 'upstream/middle'],
      });
    } finally {
      gitExec(repoPath, 'update-ref -d refs/heads/-dash');
    }
  });

  it('a flag-shaped ref that is the only one at its tip keeps its name', async () => {
    gitExec(repoPath, 'checkout --detach top');
    commit(repoPath, 'solo.txt', 'solo');
    gitExec(repoPath, 'update-ref refs/heads/-solo HEAD');
    gitExec(repoPath, 'checkout top');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(stack.layers.at(-1)).toMatchObject({ name: '-solo', refs: ['-solo'], isHead: false });
    } finally {
      gitExec(repoPath, 'update-ref -d refs/heads/-solo');
    }
  });

  it('a trunk with no common history gives no layers, not an error', async () => {
    const stack = await getStack(repoPath, 'orphan');
    expect(stack).toEqual({ trunk: 'orphan', layers: [], forkedAbove: false });
  });

  it('an unknown trunk propagates the git failure', async () => {
    await expect(getStack(repoPath, 'no-such-ref')).rejects.toThrow();
  });

  it('the walk is capped', () => {
    // Pinned so a change to the cap is a deliberate one; the spec names it.
    expect(STACK_WALK_LIMIT).toBe(1000);
  });
});

describe('getStack: merges on the line (fixture)', () => {
  const REPO_NAME = 'stack-merge-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    commit(repoPath, 'base.txt', 'base');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/main main');
    gitExec(repoPath, 'checkout -b bottom');
    commit(repoPath, 'bottom.txt', 'bottom');
    // A side branch off bottom, merged into middle with a merge commit:
    // its tip is reachable from middle, but not on the first-parent line.
    gitExec(repoPath, 'checkout -b side');
    commit(repoPath, 'side.txt', 'side');
    gitExec(repoPath, 'checkout -b middle bottom');
    commit(repoPath, 'middle.txt', 'middle');
    gitExec(repoPath, 'merge --no-ff -m "merge side into middle" side');
    gitExec(repoPath, 'checkout -b top');
    commit(repoPath, 'top.txt', 'top');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  it('a branch merged into a layer is not a layer: the walk is first-parent', async () => {
    // Without --first-parent the walk mb..HEAD would include side's
    // commit, and side would show up as a layer with middle counted
    // from it. The merge commit is middle's second commit.
    const stack = await getStack(repoPath, 'upstream/main');
    expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2', 'top:1*']);
    expect(stack.layers.flatMap((l) => l.refs)).not.toContain('side');
  });

  it('the same merged branch above HEAD is ignored too, not a fork', async () => {
    // From bottom, side and middle and top all contain HEAD; side sits
    // off the first-parent line from top, so it is dropped the same way
    // it is below HEAD — the stack is still shown.
    gitExec(repoPath, 'checkout bottom');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1*', 'middle:2', 'top:1']);
      expect(stack.forkedAbove).toBe(false);
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });
});

describe('getStack: remote copies behind their local branch (fixture)', () => {
  const REPO_NAME = 'stack-remote-behind-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    commit(repoPath, 'base.txt', 'base');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/main main');
    gitExec(repoPath, 'checkout -b bottom');
    commit(repoPath, 'bottom.txt', 'bottom');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/bottom bottom');
    // middle and top were each pushed after their first commit and have
    // a second one the remote has not seen.
    gitExec(repoPath, 'checkout -b middle');
    commit(repoPath, 'middle.txt', 'middle one');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/middle middle');
    commit(repoPath, 'middle.txt', 'middle two');
    gitExec(repoPath, 'checkout -b top');
    commit(repoPath, 'top.txt', 'top one');
    gitExec(repoPath, 'update-ref refs/remotes/upstream/top top');
    commit(repoPath, 'top.txt', 'top two');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  it('a remote copy behind its local branch is not a layer of its own (from the top)', async () => {
    // Half-pushed PRs would otherwise show as two layers each; the local
    // branch is the user's truth, and the copy at the same tip (bottom)
    // still lists in refs.
    const stack = await getStack(repoPath, 'upstream/main');
    expect(outline(stack.layers)).toEqual(['bottom:1', 'middle:2', 'top:2*']);
    expect(stack.layers.map((l) => l.refs)).toEqual([
      ['bottom', 'upstream/bottom'],
      ['middle'],
      ['top'],
    ]);
  });

  it('the same folding applies above HEAD (from the bottom)', async () => {
    gitExec(repoPath, 'checkout bottom');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1*', 'middle:2', 'top:2']);
      expect(stack.layers.map((l) => l.refs)).toEqual([
        ['bottom', 'upstream/bottom'],
        ['middle'],
        ['top'],
      ]);
      expect(stack.forkedAbove).toBe(false);
    } finally {
      gitExec(repoPath, 'checkout top');
    }
  });

  it('a remote branch with no local counterpart is still a layer', async () => {
    // Deleting the local branch leaves only the copy: a layer again, named
    // by its remote-tracking name.
    gitExec(repoPath, 'checkout bottom');
    gitExec(repoPath, 'branch -D middle');
    try {
      const stack = await getStack(repoPath, 'upstream/main');
      expect(outline(stack.layers)).toEqual(['bottom:1*', 'upstream/middle:1', 'top:3']);
    } finally {
      gitExec(repoPath, 'branch middle top~1');
      gitExec(repoPath, 'checkout top');
    }
  });
});
