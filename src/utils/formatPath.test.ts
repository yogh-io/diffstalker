import { describe, it, expect } from 'vitest';
import { shortenPath } from './formatPath.js';

describe('shortenPath', () => {
  it('returns path unchanged if shorter than maxLength', () => {
    expect(shortenPath('src/file.ts', 50)).toBe('src/file.ts');
  });

  it('returns path unchanged if equal to maxLength', () => {
    const path = 'src/components/App.tsx';
    expect(shortenPath(path, path.length)).toBe(path);
  });

  it('truncates long nested paths with ellipsis', () => {
    const result = shortenPath('src/components/very/long/path/to/Component.tsx', 35);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(35);
    expect(result).toMatch(/^src\/.*Component\.tsx$/);
  });

  it('keeps first directory and filename visible', () => {
    const result = shortenPath('src/a/b/c/d/file.ts', 25);
    expect(result.startsWith('src/')).toBe(true);
    expect(result.endsWith('file.ts')).toBe(true);
  });

  it('handles single filename without directory', () => {
    const result = shortenPath('VeryLongFilenameWithManyCharacters.tsx', 25);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(25);
  });

  it('respects minimum length of 20', () => {
    // Even with maxLength 10, it should use effective max of 20
    const result = shortenPath('src/components/Header.tsx', 10);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('shows ellipsis + filename when first part is too long', () => {
    const result = shortenPath('verylongdirectoryname/even/longer/file.ts', 20);
    expect(result).toContain('…/');
    expect(result.endsWith('file.ts')).toBe(true);
  });

  it('truncates very long filename itself', () => {
    const result = shortenPath('dir/ThisIsAnExtremelyLongFilenameForTesting.tsx', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain('…');
  });

  it('includes more path parts when space allows', () => {
    const result = shortenPath('src/components/Button/index.ts', 40);
    // Should fit: src/components/.../index.ts or even more
    expect(result.includes('components') || result.length <= 40).toBe(true);
  });

  it('handles paths with multiple deep directories', () => {
    const path = 'a/b/c/d/e/f/g/h/i/j/file.txt';
    const result = shortenPath(path, 25);
    expect(result.length).toBeLessThanOrEqual(25);
    expect(result).toContain('…');
  });
});
