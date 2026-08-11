/**
 * Install detection tests: which layouts are recognised, what command each
 * one produces, and that an install nothing owns stays unknown rather than
 * getting a guessed command. The probe is always injected — no test shells
 * out to pacman or reads the machine's PATH.
 */

import { describe, test, expect } from 'bun:test';
import { createInstallService, detectInstall, type InstallProbe } from './install.js';

function probe(overrides: Partial<InstallProbe> = {}): InstallProbe {
  return {
    onPath: () => null,
    pacmanOwner: () => Promise.resolve(null),
    writable: () => true,
    ...overrides,
  };
}

describe('detectInstall: global node_modules layouts', () => {
  test('npm global prefix', async () => {
    expect(await detectInstall('/usr/lib/node_modules/diffstalkerd', probe())).toEqual({
      method: 'npm',
      package: 'diffstalkerd',
      command: 'npm install -g diffstalkerd',
    });
  });

  test('a root-owned prefix asks for sudo', async () => {
    const info = await detectInstall(
      '/usr/lib/node_modules/diffstalkerd',
      probe({ writable: () => false })
    );
    expect(info.command).toBe('sudo npm install -g diffstalkerd');
  });

  test('a home prefix does not', async () => {
    const info = await detectInstall('/home/jo/.npm-global/lib/node_modules/diffstalkerd', probe());
    expect(info).toEqual({
      method: 'npm',
      package: 'diffstalkerd',
      command: 'npm install -g diffstalkerd',
    });
  });

  test('bun global', async () => {
    expect(
      await detectInstall('/home/jo/.bun/install/global/node_modules/diffstalkerd', probe())
    ).toEqual({
      method: 'bun',
      package: 'diffstalkerd',
      command: 'bun add -g diffstalkerd',
    });
  });

  test('pnpm global', async () => {
    expect(
      await detectInstall(
        '/home/jo/.local/share/pnpm/global/5/node_modules/diffstalkerd',
        probe()
      )
    ).toEqual({
      method: 'pnpm',
      package: 'diffstalkerd',
      command: 'pnpm add -g diffstalkerd',
    });
  });

  test('yarn global', async () => {
    expect(
      await detectInstall('/home/jo/.config/yarn/global/node_modules/diffstalkerd', probe())
    ).toEqual({
      method: 'yarn',
      package: 'diffstalkerd',
      command: 'yarn global add diffstalkerd',
    });
  });

  test('a project-local dependency is not a global install', async () => {
    // `-g` here would update a different copy than the one running.
    expect(await detectInstall('/home/jo/app/node_modules/diffstalkerd', probe())).toEqual({
      method: 'unknown',
      package: null,
      command: null,
    });
  });
});

describe('detectInstall: pacman', () => {
  const arch = '/usr/lib/diffstalker/daemon';

  test('an owned path names the package and an AUR helper', async () => {
    const info = await detectInstall(
      arch,
      probe({
        pacmanOwner: () => Promise.resolve('diffstalker-git'),
        onPath: (names) => (names.includes('yay') ? 'yay' : null),
      })
    );
    expect(info).toEqual({
      method: 'pacman',
      package: 'diffstalker-git',
      command: 'yay -S diffstalker-git',
    });
  });

  test('paru wins over yay when both are installed', async () => {
    const info = await detectInstall(
      arch,
      probe({ pacmanOwner: () => Promise.resolve('diffstalker-git'), onPath: () => 'paru' })
    );
    expect(info.command).toBe('paru -S diffstalker-git');
  });

  test('without a helper it falls back to pacman itself', async () => {
    const info = await detectInstall(
      arch,
      probe({ pacmanOwner: () => Promise.resolve('diffstalker-git') })
    );
    expect(info.command).toBe('sudo pacman -Syu diffstalker-git');
  });

  test('pacman is asked about package.json, not the directory', async () => {
    const asked: string[] = [];
    await detectInstall(
      arch,
      probe({
        pacmanOwner: (file) => {
          asked.push(file);
          return Promise.resolve('diffstalker-git');
        },
      })
    );
    expect(asked).toEqual(['/usr/lib/diffstalker/daemon/package.json']);
  });
});

describe('detectInstall: unknown', () => {
  test('a source checkout gets no command', async () => {
    expect(await detectInstall('/home/jo/gitRepos/diffstalker/packages/daemon', probe())).toEqual({
      method: 'unknown',
      package: null,
      command: null,
    });
  });

  test('a probe that throws is unknown, never a crash', async () => {
    const service = createInstallService(
      '/opt/diffstalkerd',
      probe({
        pacmanOwner: () => Promise.reject(new Error('boom')),
      })
    );
    expect(await service.info()).toEqual({ method: 'unknown', package: null, command: null });
  });
});

describe('createInstallService', () => {
  test('detects once and reuses the answer', async () => {
    let calls = 0;
    const service = createInstallService(
      '/usr/lib/diffstalker/daemon',
      probe({
        pacmanOwner: () => {
          calls++;
          return Promise.resolve('diffstalker-git');
        },
      })
    );

    await service.info();
    await service.info();
    await service.info();
    expect(calls).toBe(1);
  });
});
