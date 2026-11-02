/**
 * Preloaded by every `bun test` run (see bunfig.toml in each package). Gives
 * the run its own XDG dirs, so no test can reach the real config or cache.
 */

import { afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-test-xdg-'));

process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_CACHE_HOME = path.join(root, 'cache');
process.env.XDG_STATE_HOME = path.join(root, 'state');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
