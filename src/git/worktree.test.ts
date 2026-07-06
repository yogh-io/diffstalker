import { describe, it, expect } from 'vitest';
import { parseWorktreePorcelain } from './worktree.js';

describe('parseWorktreePorcelain', () => {
  it('parses a bare-repo layout with several worktrees', () => {
    const output = [
      'worktree /repo/.bare',
      'bare',
      '',
      'worktree /repo/main',
      'HEAD 54a99695f0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/feature',
      'HEAD ab9371014d0000000000000000000000000000000',
      'branch refs/heads/feature',
      '',
      'worktree /repo/detached',
      'HEAD 4fa2f4b2ed0000000000000000000000000000000',
      'detached',
      '',
    ].join('\n');

    const result = parseWorktreePorcelain(output);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ path: '/repo/.bare', branch: null, head: null, isBare: true });
    expect(result[1]).toMatchObject({ path: '/repo/main', branch: 'main', isBare: false });
    expect(result[2]).toMatchObject({ path: '/repo/feature', branch: 'feature' });
    // A detached worktree keeps its HEAD but has no branch.
    expect(result[3]).toMatchObject({ path: '/repo/detached', branch: null, isBare: false });
    expect(result[3].head).toBe('4fa2f4b2ed0000000000000000000000000000000');
  });

  it('parses a single non-bare worktree without a trailing blank line', () => {
    const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main'].join('\n');
    const result = parseWorktreePorcelain(output);
    expect(result).toEqual([{ path: '/repo', branch: 'main', head: 'abc123', isBare: false }]);
  });

  it('returns an empty array for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});
