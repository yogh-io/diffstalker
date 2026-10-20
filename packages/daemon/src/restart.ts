/**
 * The command that restarts this daemon, when systemd runs it.
 *
 * An update replaces the files on disk, but the running daemon keeps the old
 * code until it restarts. Under systemd that restart is one command, but only
 * when this process really is a unit's main process. Two facts decide it, and
 * neither is a guess:
 *
 *  - $SYSTEMD_EXEC_PID is our own pid. systemd sets it on the process it
 *    starts (systemd.exec(5) documents this exact check). A daemon the TUI
 *    spawned from a terminal that itself runs as a service inherits the
 *    terminal's pid there, not its own.
 *  - /proc/self/cgroup names the unit, and whether it sits under a user
 *    manager (user@<uid>.service) or the system one.
 *
 * Anything else (no systemd, cgroup v1, a scope, a unit name that would need
 * shell quoting) gives null, and the client offers the update alone. Same rule
 * as install.ts: no command beats a wrong one.
 */

import * as fs from 'node:fs';
import { warn as logWarn } from '@diffstalker/core/utils/logger';

/** Unit names that need no shell quoting; systemd's `\x2d` escapes do. */
const PLAIN_SERVICE = /^[A-Za-z0-9:_.@-]+\.service$/;
const USER_MANAGER = /^user@\d+\.service$/;
/** cgroup v2's one line: hierarchy 0, no controllers, then the path. */
const UNIFIED_LINE = /^0::(.*)$/m;

/** The restart command for the service a cgroup v2 path sits in, or null. */
export function restartFromCgroup(cgroup: string): string | null {
  const match = UNIFIED_LINE.exec(cgroup);
  if (match === null) return null;
  const segments = match[1].split('/');
  const unit = segments.at(-1) ?? '';
  if (!PLAIN_SERVICE.test(unit)) return null;
  const name = unit.slice(0, -'.service'.length);
  return segments.some((segment) => USER_MANAGER.test(segment))
    ? `systemctl --user restart ${name}`
    : `sudo systemctl restart ${name}`;
}

export function detectRestartCommand(
  pid: number = process.pid,
  env: NodeJS.ProcessEnv = process.env,
  readCgroup: () => string = () => fs.readFileSync('/proc/self/cgroup', 'utf-8')
): string | null {
  if (env.SYSTEMD_EXEC_PID !== String(pid)) return null;
  try {
    return restartFromCgroup(readCgroup());
  } catch (err) {
    // systemd started us, so this is Linux and /proc should be there.
    logWarn('Cannot read /proc/self/cgroup to name the systemd unit', err);
    return null;
  }
}
