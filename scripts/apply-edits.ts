#!/usr/bin/env bun
/**
 * apply-edits: apply a spec of exact string replacements to files, safely.
 *
 * Usage: bun scripts/apply-edits.ts SPEC.json
 *
 * Spec shape:
 *   [
 *     {
 *       "file": "packages/foo/src/bar.ts",
 *       "edits": [{ "old": "exact text", "new": "replacement" }]
 *     }
 *   ]
 *
 * Rules:
 * - Every "old" must occur EXACTLY once in its file (after the preceding
 *   edits in the same entry have been applied).
 * - The run is two-phase: all files are read and all edits validated and
 *   applied in memory first; nothing is written unless every edit in the
 *   whole spec succeeds. A failed run leaves the tree untouched.
 * - Paths are relative to the repo root (the script's parent directory).
 *
 * This exists so bulk refactor edits are reviewable commands against the
 * tree instead of ad-hoc shell heredocs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Edit {
  old: string;
  new: string;
}

interface FileEdits {
  file: string;
  edits: Edit[];
}

const repoRoot = path.resolve(import.meta.dir, '..');

function fail(message: string): never {
  console.error(`apply-edits: ${message}`);
  process.exit(1);
}

const specPath = process.argv[2];
if (!specPath) fail('usage: bun scripts/apply-edits.ts SPEC.json');

let spec: FileEdits[];
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
} catch (err) {
  fail(`cannot read spec ${specPath}: ${err instanceof Error ? err.message : err}`);
}
if (!Array.isArray(spec)) fail('spec must be an array of {file, edits}');

// Phase 1: read + apply in memory, validating every edit.
const results = new Map<string, string>();
for (const entry of spec) {
  const filePath = path.resolve(repoRoot, entry.file);
  if (!filePath.startsWith(repoRoot + path.sep)) {
    fail(`path escapes repo root: ${entry.file}`);
  }
  let content: string;
  try {
    content = results.get(filePath) ?? fs.readFileSync(filePath, 'utf-8');
  } catch {
    fail(`cannot read ${entry.file}`);
  }
  for (const [i, edit] of entry.edits.entries()) {
    if (typeof edit.old !== 'string' || typeof edit.new !== 'string') {
      fail(`${entry.file} edit ${i}: "old" and "new" must be strings`);
    }
    const count = content.split(edit.old).length - 1;
    if (count !== 1) {
      fail(
        `${entry.file} edit ${i}: expected exactly 1 occurrence, found ${count}:\n` +
          `---\n${edit.old}\n---`
      );
    }
    content = content.replace(edit.old, edit.new);
  }
  results.set(filePath, content);
}

// Phase 2: everything validated — write.
for (const [filePath, content] of results) {
  fs.writeFileSync(filePath, content);
  console.log(`edited ${path.relative(repoRoot, filePath)}`);
}
