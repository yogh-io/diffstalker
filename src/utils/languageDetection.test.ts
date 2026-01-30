import { describe, it, expect } from 'vitest';
import { getLanguageFromPath, highlightLine, highlightBlock } from './languageDetection.js';

describe('getLanguageFromPath', () => {
  it('detects TypeScript', () => {
    expect(getLanguageFromPath('src/app.ts')).toBe('typescript');
    expect(getLanguageFromPath('src/app.tsx')).toBe('typescript');
  });

  it('detects JavaScript', () => {
    expect(getLanguageFromPath('index.js')).toBe('javascript');
    expect(getLanguageFromPath('index.mjs')).toBe('javascript');
    expect(getLanguageFromPath('index.cjs')).toBe('javascript');
  });

  it('detects Python', () => {
    expect(getLanguageFromPath('script.py')).toBe('python');
  });

  it('detects Rust', () => {
    expect(getLanguageFromPath('main.rs')).toBe('rust');
  });

  it('detects Go', () => {
    expect(getLanguageFromPath('main.go')).toBe('go');
  });

  it('detects JSON', () => {
    expect(getLanguageFromPath('package.json')).toBe('json');
  });

  it('detects YAML', () => {
    expect(getLanguageFromPath('config.yaml')).toBe('yaml');
    expect(getLanguageFromPath('config.yml')).toBe('yaml');
  });

  it('detects CSS', () => {
    expect(getLanguageFromPath('styles.css')).toBe('css');
  });

  it('detects special filenames', () => {
    expect(getLanguageFromPath('Makefile')).toBe('makefile');
    expect(getLanguageFromPath('Vagrantfile')).toBe('ruby');
  });

  it('returns null for special filenames whose language is unavailable', () => {
    // Dockerfile maps to 'dockerfile' but may not be in the common set
    const result = getLanguageFromPath('Dockerfile');
    // Either 'dockerfile' or null depending on available languages
    expect(result === 'dockerfile' || result === null).toBe(true);
  });

  it('returns null for unknown extensions', () => {
    expect(getLanguageFromPath('file.xyz')).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(getLanguageFromPath('')).toBeNull();
  });

  it('returns null for files without extension', () => {
    expect(getLanguageFromPath('README')).toBeNull();
  });

  it('handles deep paths correctly', () => {
    expect(getLanguageFromPath('src/components/Button/index.tsx')).toBe('typescript');
  });

  it('detects case-insensitive extensions', () => {
    expect(getLanguageFromPath('file.JSON')).toBe('json');
  });
});

describe('highlightLine', () => {
  it('returns original content if language is empty', () => {
    expect(highlightLine('const x = 1;', '')).toBe('const x = 1;');
  });

  it('returns original content if content is empty', () => {
    expect(highlightLine('', 'typescript')).toBe('');
  });

  it('applies highlighting to TypeScript code', () => {
    const result = highlightLine('const x = 1;', 'typescript');
    // Should contain ANSI escape codes
    expect(result).toContain('\x1b[');
  });

  it('returns original on invalid language', () => {
    const input = 'some code';
    expect(highlightLine(input, 'not-a-language')).toBe(input);
  });
});

describe('highlightBlock', () => {
  it('returns original lines for empty language', () => {
    const lines = ['line1', 'line2'];
    expect(highlightBlock(lines, '')).toEqual(lines);
  });

  it('returns empty array for empty input', () => {
    expect(highlightBlock([], 'typescript')).toEqual([]);
  });

  it('highlights multiple lines preserving count', () => {
    const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const result = highlightBlock(lines, 'typescript');
    expect(result.length).toBe(3);
    // At least some lines should have highlighting
    expect(result.some((l) => l.includes('\x1b['))).toBe(true);
  });
});
