import { describe, it, expect } from 'vitest';
import { truncateWithEllipsis, formatCommitDisplay } from './commitFormat.js';

describe('truncateWithEllipsis', () => {
  it('returns string unchanged if within limit', () => {
    expect(truncateWithEllipsis('short', 10)).toBe('short');
  });

  it('returns string unchanged if exactly at limit', () => {
    expect(truncateWithEllipsis('exact', 5)).toBe('exact');
  });

  it('truncates with ellipsis when over limit', () => {
    expect(truncateWithEllipsis('this is a long string', 10)).toBe('this is...');
  });

  it('handles maxLength <= 3 without ellipsis', () => {
    expect(truncateWithEllipsis('abcdef', 3)).toBe('abc');
    expect(truncateWithEllipsis('abcdef', 2)).toBe('ab');
    expect(truncateWithEllipsis('abcdef', 1)).toBe('a');
  });
});

describe('formatCommitDisplay', () => {
  it('returns full message and refs when they fit', () => {
    const result = formatCommitDisplay('Fix bug', 'main', 80);
    expect(result.displayMessage).toBe('Fix bug');
    expect(result.displayRefs).toBe('main');
  });

  it('truncates refs first when space is tight', () => {
    const result = formatCommitDisplay('Short msg', 'origin/very-long-branch-name', 30);
    // Message should be preserved (at least 20 chars)
    expect(result.displayMessage).toBe('Short msg');
    // Refs should be truncated or empty
    expect(result.displayRefs.length).toBeLessThanOrEqual(30);
  });

  it('handles undefined refs', () => {
    const result = formatCommitDisplay('My commit', undefined, 80);
    expect(result.displayMessage).toBe('My commit');
    expect(result.displayRefs).toBe('');
  });

  it('handles empty refs string', () => {
    const result = formatCommitDisplay('My commit', '', 80);
    expect(result.displayMessage).toBe('My commit');
    expect(result.displayRefs).toBe('');
  });

  it('truncates message when needed', () => {
    const longMsg = 'A'.repeat(100);
    const result = formatCommitDisplay(longMsg, '', 40);
    expect(result.displayMessage.length).toBeLessThanOrEqual(40);
    expect(result.displayMessage).toContain('...');
  });

  it('drops refs entirely when not enough space', () => {
    const result = formatCommitDisplay('Short message here', 'ab', 20, 20);
    // maxRefsWidth = max(0, 20 - 20 - 1) = 0, so refs dropped
    expect(result.displayRefs).toBe('');
  });
});
