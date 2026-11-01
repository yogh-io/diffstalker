/**
 * What the journal keeps must cost what it says it costs: an entry holds its
 * own text, not the whole `git diff` output it was cut from.
 *
 * This runs under Node, not in bun's test runtime. The daemon runs on Node,
 * and the failure is V8's (a substring is a view that keeps its parent alive),
 * which JavaScriptCore cannot show. Left unfixed it took a daemon to 19.7 GiB:
 * Node keeps big decoded outputs in malloc memory, so V8's heap limit never
 * fired.
 *
 * Each round decodes one big output, as git output is decoded, and observes
 * it. The odd rounds also move HEAD to a new branch, so boundary labels are
 * covered as well as hunk bodies and paths.
 */

import { test, expect, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROUNDS = 40;
const FILES = 4000;
/** One output is about 2 MB, so a leak of one per round is far past this. */
const MAX_GROWTH_MB = 20;

const probe = `
import { JournalManager, createJournalStore } from ${JSON.stringify(path.join(import.meta.dir, 'JournalManager.ts'))};
import { parseDiffWithLineNumbers } from ${JSON.stringify(path.join(import.meta.dir, '../git/diffParse.ts'))};

const padding = 'x'.repeat(170);

function gitOutput(round) {
  let text = 'on-a-branch-with-a-long-name-' + round + '\\n';
  for (let i = 0; i < ${FILES}; i++) {
    const name = 'store/item-' + i + '.meta.json';
    const value = i === round ? round : 0;
    text += 'diff --git a/' + name + ' b/' + name + '\\n--- a/' + name + '\\n+++ b/' + name + '\\n';
    text += '@@ -1 +1 @@\\n-"old": "' + padding + '"\\n+"new": ' + value + ', "' + padding + '"\\n';
  }
  return Buffer.from(text).toString('utf8');
}

function observe(manager, round) {
  const output = gitOutput(round);
  const firstNewline = output.indexOf('\\n');
  manager.observe({
    status: {
      files: [],
      branch: { current: output.slice(0, firstNewline), ahead: 0, behind: 0 },
      isRepo: true,
    },
    headDiff: { lines: parseDiffWithLineNumbers(output.slice(firstNewline + 1)) },
    headOid: round % 2 === 1 ? 'head-' + round : 'head-' + (round - 1),
    stashCount: 0,
    operationInProgress: null,
    mtimes: new Map(),
    at: 1000 + round,
  });
}

function retainedMb() {
  gc();
  gc();
  const { heapUsed, external } = process.memoryUsage();
  return (heapUsed + external) / (1024 * 1024);
}

const manager = new JournalManager(createJournalStore());
observe(manager, 0);
const before = retainedMb();
for (let round = 1; round <= ${ROUNDS}; round++) observe(manager, round);
const after = retainedMb();

console.log(JSON.stringify({
  bun: process.versions.bun ?? null,
  growthMb: after - before,
  entries: manager.journalStore.entries.length,
}));
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-journal-retention-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('entries do not keep the git output they were cut from alive', async () => {
  const source = path.join(dir, 'probe.ts');
  fs.writeFileSync(source, probe);
  const built = await Bun.build({
    entrypoints: [source],
    outdir: dir,
    naming: 'probe.mjs',
    target: 'node',
  });
  expect(built.success).toBe(true);

  const run = spawnSync('node', ['--expose-gc', path.join(dir, 'probe.mjs')], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);

  const result = JSON.parse(run.stdout);
  expect(result.bun).toBeNull();
  // Guards the probe itself: it must have journaled every round.
  expect(result.entries).toBeGreaterThan(FILES + ROUNDS);
  expect(result.growthMb).toBeLessThan(MAX_GROWTH_MB);
}, 90_000);
