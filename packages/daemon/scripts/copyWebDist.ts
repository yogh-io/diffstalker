/**
 * Copy the built web SPA (packages/web/dist) into the daemon's dist/web so
 * the published diffstalkerd tarball physically contains the assets it
 * serves at GET /. Run after `vite build` in packages/web and after the
 * daemon's own tsc build (which wipes dist/).
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const dest = fileURLToPath(new URL('../dist/web/', import.meta.url));

if (!existsSync(src)) {
  console.error(`web dist not found at ${src} — run \`bun run build\` in packages/web first`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.error(`copied web UI assets to ${dest}`);
