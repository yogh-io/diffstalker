/**
 * Fetch the tree-sitter grammars and runtime this package ships.
 *
 * Release infrastructure, not a convenience. If this silently fetched the
 * wrong version, every outline in the product would be subtly wrong — a
 * `.scm` query is tuned against a specific grammar's node types, so a
 * version drift renames nodes and the query starts capturing the wrong
 * things (or nothing) with no error anywhere. So the checksums ARE the
 * gate: a mismatch fails loudly and writes nothing.
 *
 * The `.wasm` files are not committed. This repo's pack is 4.76 MiB and
 * the grammars are 2.44 MB; `diffstalker-git` is a VCS package, so every
 * AUR user would pay that on every build. Build time already needs the
 * network for `bun install`, so fetching here adds no new divergence.
 *
 *   bun run vendor           fetch and verify
 *   bun run verify           verify what is already on disk
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Artifact {
  /** Filename as shipped, and as `checksums.json` keys it. */
  file: string;
  /** npm package to pull it from. */
  pkg: string;
  /** Exact version. Never a range — see the module comment. */
  version: string;
  /** Path inside the package tarball (after the leading `package/`). */
  inPackage: string;
  sha256: string;
}

/**
 * Pinned exactly, and changed only in a reviewed commit that also re-tunes
 * the matching query and re-runs the golden fixtures.
 *
 * `web-tree-sitter.wasm` is the emscripten runtime. It ships here rather
 * than inside diffstalkerd so a default daemon install stays lean — but it
 * must stay in step with the `web-tree-sitter` JS bundled into the
 * daemon's worker, which is why the version is recorded in checksums.json
 * and checked at load.
 */
const ARTIFACTS: Artifact[] = [
  {
    file: 'web-tree-sitter.wasm',
    pkg: 'web-tree-sitter',
    version: '0.26.11',
    inPackage: 'web-tree-sitter.wasm',
    sha256: '715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc',
  },
  {
    file: 'tree-sitter-typescript.wasm',
    pkg: 'tree-sitter-typescript',
    version: '0.23.2',
    inPackage: 'tree-sitter-typescript.wasm',
    sha256: '778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d',
  },
];

/** The runtime's version, recorded so the daemon can refuse a skewed pair. */
const RUNTIME_PACKAGE = 'web-tree-sitter';

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readIfPresent(file: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(packageRoot, file));
  } catch {
    return null;
  }
}

/** Extract one file from an npm tarball into the package root. */
function fetchArtifact(artifact: Artifact, workDir: string): Buffer {
  const spec = `${artifact.pkg}@${artifact.version}`;
  execFileSync('npm', ['pack', spec, '--silent'], { cwd: workDir, stdio: ['ignore', 'ignore', 'inherit'] });

  const tarball = fs
    .readdirSync(workDir)
    .find((name) => name.endsWith('.tgz') && name.includes(artifact.pkg));
  if (tarball === undefined) throw new Error(`npm pack produced no tarball for ${spec}`);

  execFileSync('tar', ['xzf', tarball, `package/${artifact.inPackage}`], { cwd: workDir });
  const extracted = path.join(workDir, 'package', artifact.inPackage);
  const bytes = fs.readFileSync(extracted);

  fs.rmSync(path.join(workDir, tarball), { force: true });
  fs.rmSync(path.join(workDir, 'package'), { recursive: true, force: true });
  return bytes;
}

function verifyOnly(): number {
  let failed = 0;
  for (const artifact of ARTIFACTS) {
    const bytes = readIfPresent(artifact.file);
    if (bytes === null) {
      console.error(`missing: ${artifact.file}`);
      failed += 1;
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== artifact.sha256) {
      console.error(`CHECKSUM MISMATCH: ${artifact.file}`);
      console.error(`  expected ${artifact.sha256}`);
      console.error(`  actual   ${actual}`);
      failed += 1;
      continue;
    }
    console.log(`ok: ${artifact.file} (${bytes.length} bytes)`);
  }
  return failed;
}

function vendor(): number {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-vendor-'));
  let failed = 0;
  try {
    for (const artifact of ARTIFACTS) {
      const existing = readIfPresent(artifact.file);
      if (existing !== null && sha256(existing) === artifact.sha256) {
        console.log(`cached: ${artifact.file}`);
        continue;
      }

      const bytes = fetchArtifact(artifact, workDir);
      const actual = sha256(bytes);
      if (actual !== artifact.sha256) {
        // Write nothing. A wrong grammar produces wrong symbols silently,
        // so this has to stop the build rather than warn.
        console.error(`CHECKSUM MISMATCH for ${artifact.pkg}@${artifact.version}`);
        console.error(`  expected ${artifact.sha256}`);
        console.error(`  actual   ${actual}`);
        console.error('  Nothing written. Re-pin deliberately, and re-run the golden fixtures.');
        failed += 1;
        continue;
      }

      fs.writeFileSync(path.join(packageRoot, artifact.file), bytes);
      console.log(`vendored: ${artifact.file} (${bytes.length} bytes)`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (failed === 0) writeChecksums();
  return failed;
}

/**
 * The manifest the daemon reads: what is here, its hash, and the runtime
 * version this set was built against.
 */
function writeChecksums(): void {
  const runtime = ARTIFACTS.find((a) => a.pkg === RUNTIME_PACKAGE);
  if (runtime === undefined) throw new Error('no runtime artifact pinned');

  const files: Record<string, string> = {};
  for (const artifact of ARTIFACTS) files[artifact.file] = artifact.sha256;
  for (const query of fs.readdirSync(path.join(packageRoot, 'queries'))) {
    if (!query.endsWith('.scm')) continue;
    files[`queries/${query}`] = sha256(fs.readFileSync(path.join(packageRoot, 'queries', query)));
  }

  const manifest = {
    // Checked against the web-tree-sitter JS bundled into the daemon's
    // worker. A mismatch disables symbols with a specific message rather
    // than risking a wrong answer from a skewed ABI.
    webTreeSitterVersion: runtime.version,
    files,
  };
  fs.writeFileSync(
    path.join(packageRoot, 'checksums.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  console.log(`wrote checksums.json (${Object.keys(files).length} files)`);
}

const failures = process.argv.includes('--verify') ? verifyOnly() : vendor();
if (failures > 0) process.exit(1);
