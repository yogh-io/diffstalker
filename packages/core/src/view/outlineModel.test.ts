/**
 * Every outline state, one assertion each.
 *
 * These exist because the states are easy to collapse — several of them
 * look like "nothing to show" from a template — and collapsing any two
 * tells the reader something false about their file. If a change makes two
 * of these strings equal, a test here fails.
 */

import { describe, expect, test } from 'bun:test';
import { outlineStatus, type OutlineFile } from './outlineModel.js';
import type { FileSymbol, SymbolOutcome } from '../symbols/types.js';

function file(overrides: Partial<OutlineFile> = {}): OutlineFile {
  return { path: 'src/a.ts', binary: false, tooLarge: false, truncated: false, totalLines: 10, ...overrides };
}

const SYMBOL: FileSymbol = {
  kind: 'function',
  name: 'render',
  startLine: 3,
  endLine: 6,
  column: 0,
  parent: null,
};

const OK: SymbolOutcome = { status: 'ok', symbols: [SYMBOL] };
const EMPTY: SymbolOutcome = { status: 'ok', symbols: [] };

describe('the seven states', () => {
  test('symbols', () => {
    const status = outlineStatus(file(), OK);
    expect(status.kind).toBe('symbols');
    if (status.kind !== 'symbols') return;
    expect(status.symbols).toEqual([SYMBOL]);
    expect(status.note).toBeNull();
  });

  test('a truncated file says which part it describes', () => {
    const status = outlineStatus(file({ truncated: true, totalLines: 12431 }), OK);
    if (status.kind !== 'symbols') throw new Error('expected symbols');
    expect(status.note).toContain('first 5,000');
    expect(status.note).toContain('12,431');
  });

  test('parsed, but genuinely empty', () => {
    expect(outlineStatus(file(), EMPTY)).toEqual({
      kind: 'note',
      note: 'No symbols in this file.',
    });
  });

  test('an unsupported language is named', () => {
    const status = outlineStatus(file({ path: 'main.rs' }), {
      status: 'unsupported',
      reason: 'language',
    });
    expect(status).toEqual({ kind: 'note', note: 'No outline for .rs files.' });
  });

  test('a Vue file with no script block says so specifically', () => {
    expect(
      outlineStatus(file({ path: 'a.vue' }), { status: 'unsupported', reason: 'no-script-block' })
    ).toEqual({ kind: 'note', note: 'No <script> block in this component.' });
  });

  test('unavailable', () => {
    expect(outlineStatus(file(), { status: 'unavailable', reason: 'deadline' })).toEqual({
      kind: 'note',
      note: 'Outline unavailable for this file.',
    });
  });

  test('binary', () => {
    expect(outlineStatus(file({ binary: true }), null)).toEqual({
      kind: 'note',
      note: 'Binary file — no outline.',
    });
  });

  test('too large', () => {
    expect(outlineStatus(file({ tooLarge: true }), null)).toEqual({
      kind: 'note',
      note: 'File too large to outline.',
    });
  });

  test('not loaded yet', () => {
    expect(outlineStatus(file(), null)).toEqual({ kind: 'note', note: 'Outline not loaded.' });
  });
});

describe('the states stay distinct', () => {
  test('no two notes share a string', () => {
    const notes = [
      outlineStatus(file(), EMPTY),
      outlineStatus(file({ path: 'a.rs' }), { status: 'unsupported', reason: 'language' }),
      outlineStatus(file({ path: 'a.vue' }), { status: 'unsupported', reason: 'no-script-block' }),
      outlineStatus(file(), { status: 'unavailable', reason: 'error' }),
      outlineStatus(file({ binary: true }), null),
      outlineStatus(file({ tooLarge: true }), null),
      outlineStatus(file(), null),
    ].map((s) => (s.kind === 'note' ? s.note : 'SYMBOLS'));

    expect(new Set(notes).size).toBe(notes.length);
  });
});

describe('precedence', () => {
  test('a binary file reports binary, not whatever the parser said', () => {
    // The flag is a fact about the file; the outcome is about the parser.
    const status = outlineStatus(file({ binary: true }), OK);
    expect(status).toEqual({ kind: 'note', note: 'Binary file — no outline.' });
  });

  test('too-large beats an attached outcome too', () => {
    expect(outlineStatus(file({ tooLarge: true }), OK).kind).toBe('note');
  });
});
