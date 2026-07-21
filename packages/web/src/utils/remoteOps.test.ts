/**
 * condenseGitError: git's multi-line conflict stderr collapses to the
 * substantive lines — hint spam (shell advice the UI's own buttons
 * replace) drops, plain messages pass through untouched.
 */

import { test, expect } from 'vitest';
import { condenseGitError } from './remoteOps';

test('drops hint lines and joins the substantive ones', () => {
  const raw = [
    'Auto-merging a.txt',
    'CONFLICT (content): Merge conflict in a.txt',
    'error: could not apply 5347db0... feat change',
    'hint: After resolving the conflicts, mark them with',
    'hint: "git add/rm <pathspec>", then run',
    'hint: "git cherry-pick --continue".',
    '',
  ].join('\n');

  expect(condenseGitError(raw)).toBe(
    'Auto-merging a.txt — CONFLICT (content): Merge conflict in a.txt — ' +
      'error: could not apply 5347db0... feat change'
  );
});

test('a single-line message passes through unchanged', () => {
  expect(condenseGitError('A push operation is already in progress')).toBe(
    'A push operation is already in progress'
  );
});

test('an all-hint error falls back to the original text — never an empty slot', () => {
  const raw = ['hint: Use git pull to merge', 'hint: or rebase instead', ''].join('\n');
  expect(condenseGitError(raw)).toBe(raw.trim());
  expect(condenseGitError(raw)).not.toBe('');
});
