/**
 * `/file?symbols=true`, and `/health`'s capability report.
 *
 * The load-bearing test here is the FIRST one: a plain `/file` must be
 * byte-identical to what it was before symbols existed. Every existing
 * client depends on that, and an attached-by-default field would break
 * them silently.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon, Daemon } from '../server.js';
import { verifySymbolArtifacts, BUNDLED_WEB_TREE_SITTER } from './resolveArtifacts.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from '../test-helpers.js';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = verifySymbolArtifacts(path.resolve(daemonRoot, '..', 'grammars'));
const ready = artifacts !== null;

const FIXTURE = 'daemon-symbols';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-sym-${process.pid}.sock`);

let daemon: Daemon;
let repoId: string;
let repoPath: string;

function request(pathname: string): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { unix: SOCKET } as RequestInit);
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'a.ts', 'export class Widget {\n  render(): void {}\n}\n');
  writeFixtureFile(repoPath, 'notes.txt', 'plain text\n');
  fs.writeFileSync(path.join(repoPath, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00]));
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m initial');

  daemon = createDaemon({ symbols: artifacts, followFile: path.join(repoPath, '.follow') });
  await daemon.listen({ socketPath: SOCKET });

  const res = await fetch('http://localhost/repos', {
    unix: SOCKET,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  } as RequestInit);
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('/file compatibility', () => {
  test('without the param the response is byte-identical to before', async () => {
    const plain = await (await request(`/repos/${repoId}/file?path=a.ts`)).text();
    const explicit = await (
      await request(`/repos/${repoId}/file?path=a.ts&symbols=false`)
    ).text();

    expect(plain).toBe(explicit);
    expect(JSON.parse(plain)).not.toHaveProperty('symbols');
  });

  test('an invalid symbols value is a 400, not a silent default', async () => {
    const res = await request(`/repos/${repoId}/file?path=a.ts&symbols=yes`);
    expect(res.status).toBe(400);
  });

  test('a binary file carries no symbols field — its flags already say why', async () => {
    const body = (await (
      await request(`/repos/${repoId}/file?path=blob.bin&symbols=true`)
    ).json()) as Record<string, unknown>;
    expect(body.binary).toBe(true);
    expect(body).not.toHaveProperty('symbols');
  });
});

describe('/health capability', () => {
  test('reports the extensions this install can actually outline', async () => {
    const body = (await (await request('/health')).json()) as {
      symbols: { extensions: string[] };
    };
    if (ready) {
      expect(body.symbols.extensions).toEqual(
        expect.arrayContaining(['.ts', '.vue', '.js', '.java'])
      );
      expect(body.symbols.extensions).not.toContain('.rs');
    } else {
      expect(body.symbols.extensions).toEqual([]);
    }
  });
});

describe.if(ready)('outlines', () => {
  test('returns symbols for a supported file', async () => {
    const body = (await (
      await request(`/repos/${repoId}/file?path=a.ts&symbols=true`)
    ).json()) as { symbols: { status: string; symbols: { name: string }[] } };

    expect(body.symbols.status).toBe('ok');
    expect(body.symbols.symbols.map((s) => s.name)).toEqual(['Widget', 'render']);
  });

  test('an unsupported extension says so by language', async () => {
    const body = (await (
      await request(`/repos/${repoId}/file?path=notes.txt&symbols=true`)
    ).json()) as { symbols: { status: string; reason: string } };

    expect(body.symbols).toEqual({ status: 'unsupported', reason: 'language' });
  });
});

describe('with no grammars installed', () => {
  const OTHER = path.join(os.tmpdir(), `diffstalkerd-nosym-${process.pid}.sock`);
  let bare: Daemon;
  let bareId: string;

  beforeAll(async () => {
    bare = createDaemon({ symbols: null, followFile: path.join(repoPath, '.follow2') });
    await bare.listen({ socketPath: OTHER });
    const res = await fetch('http://localhost/repos', {
      unix: OTHER,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    } as RequestInit);
    bareId = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await bare.close();
    fs.rmSync(OTHER, { force: true });
  });

  test('health reports no extensions', async () => {
    const body = (await (
      await fetch('http://localhost/health', { unix: OTHER } as RequestInit)
    ).json()) as { symbols: { extensions: string[] } };
    expect(body.symbols.extensions).toEqual([]);
  });

  test('a supported file reports unavailable, NOT unsupported', async () => {
    // 'unsupported: language' would blame the file for a missing install.
    const body = (await (
      await fetch(`http://localhost/repos/${bareId}/file?path=a.ts&symbols=true`, {
        unix: OTHER,
      } as RequestInit)
    ).json()) as { symbols: { status: string; reason: string } };

    expect(body.symbols).toEqual({ status: 'unavailable', reason: 'error' });
  });
});

/**
 * The ABI pin. The runtime wasm ships with the grammars while the matching
 * JS is bundled into this daemon, so the two can be upgraded apart — and a
 * skewed pair does not error, it misbehaves. The version is a literal
 * because a published daemon has no node_modules to read it from; this
 * test is what keeps the literal honest.
 */
describe('web-tree-sitter version pin', () => {
  test('matches the version core actually depends on', () => {
    const corePkg = JSON.parse(
      fs.readFileSync(path.resolve(daemonRoot, '..', 'core', 'package.json'), 'utf8')
    ) as { devDependencies: Record<string, string> };

    expect(corePkg.devDependencies['web-tree-sitter']).toBe(BUNDLED_WEB_TREE_SITTER);
  });

  test('a grammars package built for another version is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-skew-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'checksums.json'),
        JSON.stringify({ webTreeSitterVersion: '0.0.1-other', files: {} })
      );
      const warnings: string[] = [];
      expect(verifySymbolArtifacts(dir, (m) => warnings.push(m))).toBeNull();
      expect(warnings.join(' ')).toContain('symbols disabled');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
