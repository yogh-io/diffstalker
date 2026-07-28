/**
 * Dev-proxy guard: the Vite dev server must proxy EVERY top-level path
 * the daemon's API answers.
 *
 * This exists because the failure it catches is invisible in every other
 * check. In prod the daemon serves the SPA itself and its router claims
 * the API paths first, so a new route just works; under `vite dev` an
 * unproxied path falls through to the SPA and returns index.html with a
 * 200, so the client gets HTML where it expected JSON and the feature
 * fails only on the developer's machine. Adding `GET /worktrees` without
 * this list shipped exactly that.
 *
 * Rather than trust the hand-maintained list, derive the truth from the
 * daemon's own `router.get('/…')` registrations and assert the list
 * covers it.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiPaths } from '../vite.config';

const routesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../daemon/src/routes'
);

/** The first segment of every path passed to a router.<method>('…') call. */
function daemonTopLevelPaths(): Set<string> {
  const found = new Set<string>();
  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    for (const [, route] of source.matchAll(/router\.(?:get|post|put|delete)\('(\/[^']*)'/g)) {
      found.add(`/${route.split('/')[1]}`);
    }
  }
  return found;
}

describe('vite dev proxy', () => {
  test('the daemon exposes routes at all (the regex still matches)', () => {
    // Guards the guard: a router API rename would otherwise make the
    // real assertion below pass vacuously against an empty set.
    const paths = daemonTopLevelPaths();
    expect(paths.size).toBeGreaterThan(3);
    expect(paths).toContain('/repos');
  });

  test('proxies every top-level daemon path (an unproxied one 200s as HTML in dev)', () => {
    const missing = [...daemonTopLevelPaths()].filter((p) => !apiPaths.includes(p)).sort();
    expect(missing).toEqual([]);
  });

  test('lists no path the daemon does not serve', () => {
    const served = daemonTopLevelPaths();
    const stale = apiPaths.filter((p) => !served.has(p)).sort();
    expect(stale).toEqual([]);
  });
});
