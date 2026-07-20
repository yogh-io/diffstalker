/**
 * Remove devDependencies from a package manifest just before packing, so the
 * published tarball carries none of the workspace-only @diffstalker/* packages
 * (they are bundled into dist/index.js and never installed by consumers). Run
 * from a package dir via prepack; restore the source with `git checkout --
 * package.json` in postpack.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = process.argv[2] ?? 'package.json';
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
delete pkg.devDependencies;
writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n');
