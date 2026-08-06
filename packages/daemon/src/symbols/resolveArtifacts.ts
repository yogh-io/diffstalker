/**
 * Find the grammars, and refuse to use them unless they verify.
 *
 * The grammars ship as a separate, OPT-IN package (`diffstalkerd-grammars`),
 * so a default daemon install has none and outlines are simply absent. That
 * is a first-class state, not a degraded one: `/health` reports the
 * extensions this install can actually outline, and the UI reads that.
 *
 * Two first-class sources, in order:
 *
 *   1. an explicit directory — `--grammars DIR` or `DIFFSTALKER_GRAMMARS_DIR`.
 *      Used by the systemd unit, by distro packaging (a pacman-owned path
 *      has no node_modules), and by tests, which is what lets the engine be
 *      tested without npm in the loop.
 *   2. package resolution, which finds both a real npm install and the
 *      workspace link in dev — identical paths, no prod/dev divergence.
 *
 * An explicit directory that does not verify DISABLES symbols. It does not
 * fall through to source 2: silently using different grammars than the ones
 * someone pointed at is how a wrong outline gets shipped.
 *
 * The checksums are the gate. A `.scm` query is tuned to a specific
 * grammar's node types, so a mismatched pair does not error — it captures
 * the wrong nodes and produces confidently wrong labels.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { grammarForPath, supportedExtensions } from '@diffstalker/core/symbols/languages';

/** Grammars package name. Kept here so the string has one home. */
const GRAMMARS_PACKAGE = 'diffstalkerd-grammars';

export interface SymbolArtifacts {
  grammarDir: string;
  queryDir: string;
  /** Extensions backed by a grammar that is present AND verified. */
  extensions: string[];
}

interface Manifest {
  webTreeSitterVersion: string;
  files: Record<string, string>;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readManifest(dir: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'checksums.json'), 'utf8')) as Manifest;
    if (typeof parsed.webTreeSitterVersion !== 'string' || typeof parsed.files !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The `web-tree-sitter` version bundled into this daemon's worker.
 *
 * A literal, NOT a runtime `require('web-tree-sitter/package.json')`.
 * web-tree-sitter is a devDependency inlined into the worker bundle at
 * build time, so a published daemon has no `node_modules/web-tree-sitter`
 * to read — the runtime lookup would return null on exactly the installs
 * that matter and the skew check would silently never fire.
 *
 * Kept in step with core's pinned devDependency by a test.
 */
export const BUNDLED_WEB_TREE_SITTER = '0.26.11';

/** Every file in the manifest hashes to what the manifest says. */
function verifyFiles(dir: string, manifest: Manifest, warn: (message: string) => void): boolean {
  for (const [file, expected] of Object.entries(manifest.files)) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(dir, file));
    } catch {
      warn(`grammars: missing ${file}`);
      return false;
    }
    if (sha256(bytes) !== expected) {
      warn(`grammars: checksum mismatch for ${file}`);
      return false;
    }
  }
  return true;
}

/** Grammar ids with a verified `.wasm` and `.scm` present. */
function presentGrammars(manifest: Manifest): Set<string> {
  const grammars = new Set<string>();
  for (const file of Object.keys(manifest.files)) {
    const match = /^tree-sitter-(.+)\.wasm$/.exec(file);
    if (match !== null && manifest.files[`queries/${match[1]}.scm`] !== undefined) {
      grammars.add(match[1]);
    }
  }
  return grammars;
}

/**
 * Verify one directory. Null means "do not use these" — a caller must not
 * then try somewhere else if the directory was explicitly named.
 */
export function verifySymbolArtifacts(
  dir: string,
  warn: (message: string) => void = () => {}
): SymbolArtifacts | null {
  const manifest = readManifest(dir);
  if (manifest === null) {
    warn(`grammars: no readable checksums.json in ${dir}`);
    return null;
  }

  if (manifest.webTreeSitterVersion !== BUNDLED_WEB_TREE_SITTER) {
    // The runtime wasm ships with the grammars while the matching JS is
    // bundled into this daemon, so the two can be upgraded apart. A skewed
    // pair is refused outright rather than risking a wrong answer.
    warn(
      `grammars: built for web-tree-sitter ${manifest.webTreeSitterVersion}, ` +
        `this daemon bundles ${BUNDLED_WEB_TREE_SITTER} — symbols disabled`
    );
    return null;
  }

  if (!verifyFiles(dir, manifest, warn)) return null;

  const grammars = presentGrammars(manifest);
  // Capability comes from what is INSTALLED, never from the static map: a
  // build that ships two grammars must not advertise four.
  const extensions = supportedExtensions().filter((ext) => {
    const match = grammarForPath(`x${ext}`);
    return match !== null && grammars.has(match.grammar);
  });

  if (extensions.length === 0) {
    warn('grammars: no usable grammar found');
    return null;
  }

  return { grammarDir: dir, queryDir: path.join(dir, 'queries'), extensions };
}

/**
 * Locate and verify the grammars, or null when this install has none.
 *
 * `explicitDir` wins outright: if it is given and does not verify, symbols
 * are off. Nothing is attempted after an explicit choice fails.
 */
export function resolveSymbolArtifacts(
  explicitDir: string | null,
  warn: (message: string) => void = () => {}
): SymbolArtifacts | null {
  if (explicitDir !== null) return verifySymbolArtifacts(explicitDir, warn);

  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${GRAMMARS_PACKAGE}/checksums.json`);
    return verifySymbolArtifacts(path.dirname(manifestPath), warn);
  } catch {
    // Not installed. The common case, and not a warning: outlines are
    // opt-in and their absence is normal.
    return null;
  }
}
