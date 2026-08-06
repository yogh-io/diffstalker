/**
 * Proof that the symbols layering rules actually fire.
 *
 * A dependency-cruiser rule whose `from`/`to` patterns match nothing passes
 * vacuously and forever — it reports a clean cruise while guarding
 * absolutely nothing. Every rule below is checked by writing a file that
 * SHOULD violate it and asserting the violation is reported.
 *
 * The temp files live in the real source tree, because the rules are
 * written against `^src/…` paths; each is removed afterwards.
 *
 * `symbols-pure-no-extract` is NOT covered here: it matches four exact
 * filenames, so it cannot be provoked by a planted file, and its target
 * (`extract.ts`) does not exist yet. Its canary belongs in the commit that
 * adds the engine — noted so the gap is deliberate rather than forgotten.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');

const written: string[] = [];

/** Write a throwaway module under src/ and remember it for cleanup. */
function plant(relPath: string, source: string): string {
  const target = path.join(packageRoot, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
  written.push(target);
  return relPath;
}

/**
 * Rule names violated when cruising `relPath`.
 *
 * Runs the same `depcruise` CLI the lint script and CI run, rather than
 * the programmatic API — the API's TypeScript parse fails under bun, and
 * shelling out also means this test exercises the exact command that
 * gates a commit.
 */
function violations(relPath: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync(
      'bunx',
      ['--bun', 'depcruise', relPath, '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
      { cwd: packageRoot, encoding: 'utf8', env: process.env }
    );
  } catch (err) {
    // A cruise that finds violations exits non-zero; its JSON is still on
    // stdout, and that is exactly the case under test.
    const out = (err as { stdout?: string }).stdout;
    if (out === undefined) throw err;
    stdout = out;
  }
  const parsed = JSON.parse(stdout) as {
    summary: { violations: { rule: { name: string } }[] };
  };
  return parsed.summary.violations.map((v) => v.rule.name);
}

afterEach(() => {
  for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});

describe('the symbols rules are not vacuous', () => {
  test('symbols-no-upper-layers fires when symbols/ imports view/', () => {
    const file = plant(
      'src/symbols/__canary_upper__.ts',
      "import { shortenPath } from '../view/formatPath.js';\nexport const x = shortenPath;\n"
    );
    expect(violations(file)).toContain('symbols-no-upper-layers');
  });

  test('view-no-node-runtime fires on a RUNTIME import of symbols/', () => {
    const file = plant(
      'src/view/__canary_runtime__.ts',
      "import { grammarForPath } from '../symbols/languages.js';\nexport const x = grammarForPath;\n"
    );
    expect(violations(file)).toContain('view-no-node-runtime');
  });

  test('a type-only import of symbols/ from view/ is allowed', () => {
    const file = plant(
      'src/view/__canary_typeonly__.ts',
      "import type { FileSymbol } from '../symbols/types.js';\nexport type X = FileSymbol;\n"
    );
    expect(violations(file)).not.toContain('view-no-node-runtime');
  });

  test('a clean symbols module reports no violations at all', () => {
    const file = plant(
      'src/symbols/__canary_clean__.ts',
      "import type { FileSymbol } from './types.js';\nexport type X = FileSymbol;\n"
    );
    expect(violations(file)).toEqual([]);
  });
});
