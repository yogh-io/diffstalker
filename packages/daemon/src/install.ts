/**
 * How this daemon was installed, and the one command that updates it.
 *
 * The version indicator can say "0.12.1, npm has 0.13.0" without being able
 * to say what to type — an npm global install, an Arch package and a source
 * checkout are updated three different ways. This module answers that from
 * where the daemon's own files actually live:
 *
 *  - a global node_modules layout (npm/bun/pnpm/yarn) names its manager;
 *  - anything else is offered to pacman, which answers with the owning
 *    package (`diffstalker-git` from the AUR) or nothing;
 *  - anything left — a source checkout, a `bun link`, a local dependency —
 *    is 'unknown' with no command, because a wrong update command is worse
 *    than none: it either fails or, with npm's prefix on Arch, plants
 *    unowned files over a packaged install.
 *
 * Detection runs at most once per daemon (the answer cannot change while
 * the process it describes keeps running) and never throws — an install
 * this cannot name is a normal state, not an error.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package manager an install came from, or 'unknown'. */
export type InstallMethod = 'npm' | 'bun' | 'pnpm' | 'yarn' | 'pacman' | 'unknown';

export interface InstallInfo {
  method: InstallMethod;
  /** The package name as installed ('diffstalkerd', or the pacman package). */
  package: string | null;
  /** A copy-pasteable command that updates this install. Null when unknown. */
  command: string | null;
}

export const UNKNOWN_INSTALL: InstallInfo = { method: 'unknown', package: null, command: null };

/** The npm package this daemon ships as. */
export const NPM_PACKAGE = 'diffstalkerd';

/** pacman reads a local database; a slow answer means something is wrong. */
export const PACMAN_TIMEOUT_MS = 3000;

/** AUR helpers, most-preferred first. Both rebuild a -git package on `-S`. */
const AUR_HELPERS = ['paru', 'yay'];

/**
 * The machine-facing half of detection, so tests never shell out.
 */
export interface InstallProbe {
  /** The first of `names` that is executable on PATH, or null. */
  onPath(names: string[]): string | null;
  /** The pacman package owning `file`, or null (unowned, or no pacman). */
  pacmanOwner(file: string): Promise<string | null>;
  /** Whether this process may write to `dir` (false means the update needs sudo). */
  writable(dir: string): boolean;
}

interface GlobalLayout {
  method: InstallMethod;
  /** Matched against the install dir with forward slashes. */
  pattern: RegExp;
  command: string;
}

/**
 * Global-install layouts, specific ones first. Each pattern ends at the
 * package directory itself, so a project-local `node_modules/diffstalkerd`
 * matches nothing and stays 'unknown' — `-g` would update the wrong copy.
 */
const GLOBAL_LAYOUTS: GlobalLayout[] = [
  // $BUN_INSTALL/install/global/node_modules/diffstalkerd
  {
    method: 'bun',
    pattern: /\/install\/global\/node_modules\/diffstalkerd$/,
    command: `bun add -g ${NPM_PACKAGE}`,
  },
  // ~/.local/share/pnpm/global/5/node_modules/diffstalkerd
  {
    method: 'pnpm',
    pattern: /\/pnpm\/global\/\d+\/node_modules\/diffstalkerd$/,
    command: `pnpm add -g ${NPM_PACKAGE}`,
  },
  // ~/.config/yarn/global/node_modules/diffstalkerd
  {
    method: 'yarn',
    pattern: /\/yarn\/global\/node_modules\/diffstalkerd$/,
    command: `yarn global add ${NPM_PACKAGE}`,
  },
  // <prefix>/lib/node_modules/diffstalkerd — npm's global layout everywhere
  // but Windows, and the loosest of these, so it goes last.
  {
    method: 'npm',
    pattern: /\/lib\/node_modules\/diffstalkerd$/,
    command: `npm install -g ${NPM_PACKAGE}`,
  },
];

/** Name the install at `dir` (the daemon's package root). Never throws. */
export async function detectInstall(dir: string, probe: InstallProbe): Promise<InstallInfo> {
  const normalized = dir.split(path.sep).join('/').replace(/\/+$/, '');

  for (const layout of GLOBAL_LAYOUTS) {
    if (!layout.pattern.test(normalized)) continue;
    // A prefix under /usr or /usr/local is root-owned, and the copied
    // command has to say so or it just fails in the user's terminal.
    const sudo = probe.writable(dir) ? '' : 'sudo ';
    return { method: layout.method, package: NPM_PACKAGE, command: `${sudo}${layout.command}` };
  }

  // package.json rather than the directory: pacman answers for any path
  // inside a packaged tree, and `filesystem` owning /usr/lib is not an
  // answer about us.
  const owner = await probe.pacmanOwner(path.join(dir, 'package.json'));
  if (owner !== null) {
    const helper = probe.onPath(AUR_HELPERS);
    return {
      method: 'pacman',
      package: owner,
      // pacman itself cannot update an AUR package, but with no helper
      // installed it is still the only true thing to say.
      command: helper ? `${helper} -S ${owner}` : `sudo pacman -Syu ${owner}`,
    };
  }

  return UNKNOWN_INSTALL;
}

export const systemProbe: InstallProbe = {
  onPath(names) {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const name of names) {
      for (const dir of dirs) {
        try {
          fs.accessSync(path.join(dir, name), fs.constants.X_OK);
          return name;
        } catch {
          // Not here; keep looking.
        }
      }
    }
    return null;
  },

  pacmanOwner(file) {
    return new Promise((resolve) => {
      // A missing pacman (ENOENT) lands in the same error branch as an
      // unowned file: both mean "not a pacman install".
      execFile('pacman', ['-Qoq', '--', file], { timeout: PACMAN_TIMEOUT_MS }, (error, stdout) => {
        if (error) return resolve(null);
        const name = stdout.trim().split('\n')[0]?.trim();
        resolve(name ? name : null);
      });
    });
  },

  writable(dir) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The daemon package's own directory — dist/ beside package.json when
 * built, packages/daemon/ in development. Symlinks are resolved, so a
 * `bun link`ed global entry reports the source checkout it points at
 * (and is then correctly 'unknown', not an npm install).
 */
export function daemonPackageDir(): string {
  const dir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

export interface InstallService {
  info(): Promise<InstallInfo>;
}

/** Detection behind a permanent cache: at most one pacman call per daemon. */
export function createInstallService(
  dir: string = daemonPackageDir(),
  probe: InstallProbe = systemProbe
): InstallService {
  let pending: Promise<InstallInfo> | null = null;
  return {
    info() {
      pending ??= detectInstall(dir, probe).catch(() => UNKNOWN_INSTALL);
      return pending;
    },
  };
}
