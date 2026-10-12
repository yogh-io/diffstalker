import { describe, test, expect } from 'vitest';
import { sharedPrefix } from './stackNames';

describe('sharedPrefix', () => {
  test('cuts the shared words, at a separator', () => {
    expect(
      sharedPrefix([
        'feature/aer-4673-jsp-to-html',
        'feature/aer-4693-nginx',
        'feature/aer-4693-nginx-image',
      ])
    ).toBe('feature/aer-');
  });

  test('never cuts inside a word', () => {
    // `aer-469` is common, but `469` is half a word.
    expect(sharedPrefix(['aer-4693-nginx', 'aer-4694-headers'])).toBe('aer-');
    expect(sharedPrefix(['nginx', 'nginx-image'])).toBe('');
  });

  test('cuts nothing when a name would be left empty', () => {
    expect(sharedPrefix(['feature/', 'feature/x'])).toBe('');
  });

  test('cuts nothing for one name, or names with nothing in common', () => {
    expect(sharedPrefix(['feature/aer-4673-jsp-to-html'])).toBe('');
    expect(sharedPrefix(['feature/a', 'upstream/b'])).toBe('');
    expect(sharedPrefix([])).toBe('');
  });
});
