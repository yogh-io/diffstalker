import { describe, it, expect } from 'vitest';
import { getLanguageFromPath } from './languageDetection.js';

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

  it('maps special filenames even when highlighters may not support them', () => {
    // Detection is pure: highlighters (CLI syntaxHighlight) tolerate unsupported languages
    expect(getLanguageFromPath('Dockerfile')).toBe('dockerfile');
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
