import { describe, it, expect } from 'bun:test';
import { blobUrl, mediaUrl } from './blobRef.js';

describe('blobUrl', () => {
  it('builds a relative same-origin url', () => {
    expect(blobUrl('abc123', { path: 'src/logo.png', side: 'worktree' })).toBe(
      '/repos/abc123/blob?path=src%2Flogo.png&side=worktree'
    );
  });

  it('emits v only when a version is supplied', () => {
    const ref = { path: 'a.png', side: 'head' as const };
    expect(blobUrl('r', ref)).toBe('/repos/r/blob?path=a.png&side=head');
    expect(blobUrl('r', { ...ref, version: '9f8e7d6' })).toBe(
      '/repos/r/blob?path=a.png&side=head&v=9f8e7d6'
    );
  });

  it('encodes a version that is not a plain oid', () => {
    // The worktree side's version is `${size}-${mtimeMs}`, but nothing stops a
    // caller passing something with a & in it.
    expect(blobUrl('r', { path: 'a.png', side: 'worktree', version: '12&x=1' })).toBe(
      '/repos/r/blob?path=a.png&side=worktree&v=12%26x%3D1'
    );
  });

  it('encodes spaces in the path', () => {
    expect(blobUrl('r', { path: 'my images/a b.png', side: 'index' })).toBe(
      '/repos/r/blob?path=my%20images%2Fa%20b.png&side=index'
    );
  });

  it('encodes a fragment marker so the query is not cut short', () => {
    expect(blobUrl('r', { path: 'a#b.png', side: 'worktree' })).toBe(
      '/repos/r/blob?path=a%23b.png&side=worktree'
    );
  });

  it('encodes ? and & and = so no extra parameter can be smuggled in', () => {
    expect(blobUrl('r', { path: 'a?side=head&b.png', side: 'worktree' })).toBe(
      '/repos/r/blob?path=a%3Fside%3Dhead%26b.png&side=worktree'
    );
  });

  it('encodes + so it does not decode back to a space', () => {
    expect(blobUrl('r', { path: 'a+b.png', side: 'worktree' })).toBe(
      '/repos/r/blob?path=a%2Bb.png&side=worktree'
    );
  });

  it('encodes non-ASCII as UTF-8', () => {
    expect(blobUrl('r', { path: 'ünïcode/日本.png', side: 'worktree' })).toBe(
      '/repos/r/blob?path=%C3%BCn%C3%AFcode%2F%E6%97%A5%E6%9C%AC.png&side=worktree'
    );
  });

  it('passes .. through unchanged — rejecting traversal is the daemon side', () => {
    expect(blobUrl('r', { path: '../../etc/passwd', side: 'worktree' })).toBe(
      '/repos/r/blob?path=..%2F..%2Fetc%2Fpasswd&side=worktree'
    );
  });

  it('encodes the repo id segment', () => {
    expect(blobUrl('a b/c#d', { path: 'x.png', side: 'worktree' })).toBe(
      '/repos/a%20b%2Fc%23d/blob?path=x.png&side=worktree'
    );
  });

  it('round-trips the path through URL parsing', () => {
    const path = 'weird & names/a b?c#d+e/日本.png';
    const url = new URL(blobUrl('id', { path, side: 'index', version: 'v 1' }), 'https://x');
    expect(url.searchParams.get('path')).toBe(path);
    expect(url.searchParams.get('side')).toBe('index');
    expect(url.searchParams.get('v')).toBe('v 1');
  });
});

describe('mediaUrl', () => {
  it('spells staged as 0 or 1', () => {
    expect(mediaUrl('r', 'a.png', false)).toBe('/repos/r/media?path=a.png&staged=0');
    expect(mediaUrl('r', 'a.png', true)).toBe('/repos/r/media?path=a.png&staged=1');
  });

  it('encodes the id and the path', () => {
    expect(mediaUrl('a b', 'my images/a&b?c#d+e/日本.png', false)).toBe(
      '/repos/a%20b/media?path=my%20images%2Fa%26b%3Fc%23d%2Be%2F%E6%97%A5%E6%9C%AC.png&staged=0'
    );
  });

  it('passes .. through unchanged', () => {
    expect(mediaUrl('r', '../../etc/passwd', true)).toBe(
      '/repos/r/media?path=..%2F..%2Fetc%2Fpasswd&staged=1'
    );
  });

  it('round-trips the path through URL parsing', () => {
    const path = 'a b/c&d#e+f/日本.png';
    const url = new URL(mediaUrl('id', path, true), 'https://x');
    expect(url.searchParams.get('path')).toBe(path);
    expect(url.searchParams.get('staged')).toBe('1');
  });
});
