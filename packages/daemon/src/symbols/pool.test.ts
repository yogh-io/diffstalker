/**
 * The symbol worker and its bounds, against the real engine and real
 * grammars.
 *
 * Two tests here are the whole reason the worker exists, and both were
 * absent from the design that preceded it:
 *
 * - **the poisoned-successor case**: after a cancelled extraction, the NEXT
 *   file must be exactly right. A deadline test that only checks the
 *   cancelled request's own status passes while every later answer is
 *   wrong, which is precisely the bug.
 * - **a wall-clock ceiling** on pathological input, asserted as elapsed
 *   time rather than as a status value. A status can be produced by a
 *   thread that blocked for two seconds first.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSymbolPool, type SymbolPool } from './pool.js';
import { verifySymbolArtifacts } from './resolveArtifacts.js';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const grammarDir = path.resolve(daemonRoot, '..', 'grammars');

const artifacts = verifySymbolArtifacts(grammarDir);
/** Run vendor:grammars and these light up; without it they skip loudly. */
const ready = artifacts !== null;

let pool: SymbolPool;

const SAMPLE = [
  'export class Widget {',
  '  render(): number {',
  '    return 1;',
  '  }',
  '}',
  '',
  'export function free(): void {}',
].join('\n');

beforeAll(() => {
  if (!ready) return;
  pool = createSymbolPool({ ...artifacts, timeoutMs: 400 });
});

afterAll(async () => {
  if (ready) await pool.dispose();
});

describe.if(ready)('extracting', () => {
  test('returns symbols with their kinds, names and 1-based lines', async () => {
    const outcome = await pool.extract('a.ts', SAMPLE);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    expect(outcome.symbols.map((s) => `${s.kind} ${s.name}@${s.startLine}`)).toEqual([
      'class Widget@1',
      'method render@2',
      'function free@7',
    ]);
  });

  test('attributes a method to its enclosing class', async () => {
    const outcome = await pool.extract('a.ts', SAMPLE);
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.symbols.find((s) => s.name === 'render')?.parent).toBe('Widget');
    expect(outcome.symbols.find((s) => s.name === 'free')?.parent).toBeNull();
  });

  test('recovers the symbols around a half-typed function', async () => {
    // The realistic mid-edit shape: something is being typed at the end of
    // the file, and everything above it is still valid. Error recovery has
    // to keep answering for the intact part.
    const broken = `${SAMPLE}\n\nexport function halfTyped(`;
    const outcome = await pool.extract('broken.ts', broken);

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.symbols.map((s) => s.name)).toContain('Widget');
    expect(outcome.symbols.map((s) => s.name)).toContain('render');
    expect(outcome.symbols.map((s) => s.name)).toContain('free');
  });

  test('an unsupported extension never reaches the worker', async () => {
    expect(pool.supported('main.rs')).toBe(false);
    const outcome = await pool.extract('main.rs', 'fn main() {}');
    expect(outcome).toEqual({ status: 'unsupported', reason: 'language' });
  });

  test('a Vue file with no script block is distinct from one with no symbols', async () => {
    const empty = await pool.extract('a.vue', '<template><p>hi</p></template>\n');
    expect(empty).toEqual({ status: 'unsupported', reason: 'no-script-block' });

    const none = await pool.extract('b.vue', '<script setup>\nconst a = 1;\n</script>\n');
    expect(none.status).toBe('ok');
  });

  test('a Vue file reports file-absolute lines across both script blocks', async () => {
    const sfc = [
      '<script lang="ts">',
      'export function first(): void {}',
      '</script>',
      '',
      '<template><p>hi</p></template>',
      '',
      '<script setup lang="ts">',
      'export function second(): void {}',
      '</script>',
    ].join('\n');

    const outcome = await pool.extract('c.vue', sfc);
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.symbols.map((s) => `${s.name}@${s.startLine}`)).toEqual([
      'first@2',
      'second@8',
    ]);
  });
});

describe.if(ready)('bounds', () => {
  /** Pathological for the QUERY, which the engine's own deadline misses. */
  const NASTY = '{a:'.repeat(12_000);

  test('a pathological file is cut off at the wall clock, not left to run', async () => {
    const started = Date.now();
    const outcome = await pool.extract('nasty.ts', NASTY);
    const elapsed = Date.now() - started;

    // Either it finished fast or it was cut off — never seconds either way.
    expect(elapsed).toBeLessThan(2000);
    expect(['ok', 'unavailable']).toContain(outcome.status);
  }, 10_000);

  test('THE POISONED SUCCESSOR: after a cancel, the next file is exactly right', async () => {
    // This is the bug the worker exists for. Without discard-and-respawn,
    // this returns the previous file's symbols, or throws from inside wasm.
    await pool.extract('nasty.ts', NASTY);

    const outcome = await pool.extract('after.ts', SAMPLE);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.symbols.map((s) => `${s.kind} ${s.name}@${s.startLine}`)).toEqual([
      'class Widget@1',
      'method render@2',
      'function free@7',
    ]);
  }, 15_000);

  test('a 256 KB single line does not hang', async () => {
    const started = Date.now();
    await pool.extract('min.ts', `const x = "${'y'.repeat(256 * 1024)}";\n`);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 10_000);

  test('XML that happens to be named .ts is answered, not hung on', async () => {
    // A Qt Linguist translation file uses the .ts extension — ordinary
    // input that maps to the TypeScript grammar and parses to garbage.
    const qt = `<?xml version="1.0"?>\n<TS version="2.1">\n${'<message><source>x</source></message>\n'.repeat(2000)}</TS>\n`;
    const started = Date.now();
    const outcome = await pool.extract('translations.ts', qt);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(['ok', 'unavailable']).toContain(outcome.status);
  }, 10_000);
});

describe.if(ready)('caching and lifecycle', () => {
  test('identical content is answered from cache', async () => {
    const first = await pool.extract('cached.ts', SAMPLE);
    const second = await pool.extract('cached.ts', SAMPLE);
    expect(second).toEqual(first);
  });

  test('a disposed pool answers unavailable rather than throwing', async () => {
    const throwaway = createSymbolPool({ ...artifacts!, timeoutMs: 400 });
    await throwaway.extract('a.ts', SAMPLE);
    await throwaway.dispose();
    expect(await throwaway.extract('a.ts', SAMPLE)).toEqual({
      status: 'unavailable',
      reason: 'error',
    });
  });
});

describe('artifact verification', () => {
  test('a directory with no checksums.json is refused', () => {
    expect(verifySymbolArtifacts(daemonRoot)).toBeNull();
  });

  test('the vendored grammars verify, or the suite says why', () => {
    if (!ready) {
      console.warn('grammars not vendored — run `bun run vendor` in packages/grammars');
    }
    expect(ready).toBe(true);
  });

  test.skipIf(!ready)('capability comes from what is installed', () => {
    // TypeScript is vendored; Java is not, so it must not be advertised.
    expect(artifacts!.extensions).toContain('.ts');
    expect(artifacts!.extensions).toContain('.vue');
    expect(artifacts!.extensions).not.toContain('.java');
  });
});
