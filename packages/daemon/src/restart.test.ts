/**
 * Restart detection tests: a daemon gets a restart command only when systemd
 * started this very process and its cgroup names a plain .service unit. The
 * env and the cgroup read are always injected; no test reads this machine's
 * /proc.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { detectRestartCommand, restartFromCgroup } from './restart.js';

const USER_UNIT = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/diffstalkerd.service\n';

describe('restartFromCgroup', () => {
  test('a user unit restarts through the user manager', () => {
    expect(restartFromCgroup(USER_UNIT)).toBe('systemctl --user restart diffstalkerd');
  });

  test('a system unit asks for sudo', () => {
    expect(restartFromCgroup('0::/system.slice/diffstalkerd.service\n')).toBe(
      'sudo systemctl restart diffstalkerd'
    );
  });

  test('the unit is named as found, template instances included', () => {
    expect(
      restartFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/ds@work.service')
    ).toBe('systemctl --user restart ds@work');
  });

  test('a scope is not a service: nothing to restart', () => {
    expect(restartFromCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull();
  });

  test('the user manager itself is not our unit', () => {
    expect(
      restartFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/init.scope\n')
    ).toBeNull();
  });

  test('a unit name that would need shell quoting gets no command', () => {
    expect(restartFromCgroup('0::/system.slice/diff\\x2dstalker.service\n')).toBeNull();
  });

  test('cgroup v1 has no unified line: no command', () => {
    expect(
      restartFromCgroup('12:pids:/user.slice\n1:name=systemd:/system.slice/diffstalkerd.service\n')
    ).toBeNull();
  });
});

describe('detectRestartCommand', () => {
  test('systemd started this process: the unit from the cgroup', () => {
    expect(detectRestartCommand(42, { SYSTEMD_EXEC_PID: '42' }, () => USER_UNIT)).toBe(
      'systemctl --user restart diffstalkerd'
    );
  });

  test('no SYSTEMD_EXEC_PID: not a service, and /proc is never read', () => {
    let reads = 0;
    const read = (): string => {
      reads++;
      return USER_UNIT;
    };
    expect(detectRestartCommand(42, {}, read)).toBeNull();
    expect(reads).toBe(0);
  });

  test("an inherited SYSTEMD_EXEC_PID names another process: not ours to restart", () => {
    // A daemon the TUI spawned from a terminal that runs as a service.
    expect(detectRestartCommand(42, { SYSTEMD_EXEC_PID: '7' }, () => USER_UNIT)).toBeNull();
  });

  test('an unreadable cgroup gives no command, and says why in the log', () => {
    const lines: string[] = [];
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write);
    const read = (): string => {
      throw new Error('EACCES');
    };
    try {
      expect(detectRestartCommand(42, { SYSTEMD_EXEC_PID: '42' }, read)).toBeNull();
    } finally {
      stderrSpy.mockRestore();
    }
    expect(lines.join('')).toContain('Cannot read /proc/self/cgroup');
  });
});
