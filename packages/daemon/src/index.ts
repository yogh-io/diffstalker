/**
 * diffstalkerd entry point: parse CLI args, start the daemon, and shut
 * down cleanly on SIGINT/SIGTERM/SIGHUP.
 *
 * Socket resolution order: explicit --socket/--port, then a systemd
 * socket-activation fd (LISTEN_FDS), then $XDG_RUNTIME_DIR/diffstalker/.
 * There is deliberately no /tmp fallback — a world-writable default
 * would hide the problem instead of surfacing it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runtimeDir, cacheDir } from '@diffstalker/core/utils/xdg';
import { createDaemon, ListenOptions } from './server.js';

const SOCKET_NAME = 'diffstalkerd.sock';

/** systemd passes activated sockets starting at fd 3 (SD_LISTEN_FDS_START). */
const SD_LISTEN_FDS_START = 3;

const HELP = `diffstalkerd — diffstalker daemon (REST API + SSE over @diffstalker/core)

Usage: diffstalkerd [options]

Options:
  --socket PATH        Bind a unix socket at PATH
                       (default: $XDG_RUNTIME_DIR/diffstalker/${SOCKET_NAME})
  --port N             Bind TCP port N instead of a unix socket
  --host H             Host to bind with --port (default: 127.0.0.1)
  --follow-file PATH   Hook file to follow (created when missing)
                       (default: ~/.cache/diffstalker/target)
  --no-follow          Disable follow mode (no hook-file watcher)
  --help, -h           Show this help
`;

function expectValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export interface CliOptions extends ListenOptions {
  /** Explicit hook file from --follow-file. */
  followFile?: string;
  /** --no-follow: no hook-file watcher at all. */
  noFollow?: boolean;
}

export function parseArgs(argv: string[]): CliOptions | 'help' {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--socket':
        options.socketPath = expectValue(argv, ++i, '--socket');
        break;
      case '--port':
        options.port = Number(expectValue(argv, ++i, '--port'));
        if (!Number.isInteger(options.port) || options.port < 0) {
          throw new Error('--port requires a non-negative integer');
        }
        break;
      case '--host':
        options.host = expectValue(argv, ++i, '--host');
        break;
      case '--follow-file':
        options.followFile = expectValue(argv, ++i, '--follow-file');
        break;
      case '--no-follow':
        options.noFollow = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.socketPath !== undefined && options.port !== undefined) {
    throw new Error('--socket and --port are mutually exclusive');
  }
  if (options.followFile !== undefined && options.noFollow) {
    throw new Error('--follow-file and --no-follow are mutually exclusive');
  }
  return options;
}

/** True when systemd handed us pre-bound listening fds. */
function hasActivationFds(): boolean {
  return (
    process.env.LISTEN_PID === String(process.pid) && Number(process.env.LISTEN_FDS) >= 1
  );
}

/**
 * Fill in where to listen when neither --socket nor --port was given:
 * a systemd activation fd when present, otherwise the XDG runtime dir.
 */
function applyListenDefaults(options: ListenOptions): void {
  if (options.socketPath !== undefined || options.port !== undefined) return;

  if (hasActivationFds()) {
    options.fd = SD_LISTEN_FDS_START;
    return;
  }

  const dir = runtimeDir();
  if (!dir) {
    console.error(
      'diffstalkerd: XDG_RUNTIME_DIR is not set and no --socket/--port given.\n' +
        'Refusing to guess a socket location; pass --socket PATH or set XDG_RUNTIME_DIR.'
    );
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  options.socketPath = path.join(dir, SOCKET_NAME);
}

async function main(): Promise<void> {
  process.title = 'diffstalkerd';

  let options: CliOptions | 'help';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(HELP);
    process.exit(2);
  }

  if (options === 'help') {
    console.log(HELP);
    return;
  }

  applyListenDefaults(options);

  // Follow is on by default: the daemon owns the hook file the TUI's follow
  // mode uses today. --no-follow disables it entirely.
  const followFile = options.noFollow
    ? undefined
    : (options.followFile ?? path.join(cacheDir(), 'target'));

  const daemon = createDaemon({ followFile });
  await daemon.listen(options);
  // Status lines go to stderr: stdout stays clean for piping, and journald
  // captures stderr just the same.
  if (options.fd !== undefined) {
    console.error(`diffstalkerd listening on inherited socket (fd ${options.fd})`);
  } else if (options.socketPath) {
    console.error(`diffstalkerd listening on unix socket ${options.socketPath}`);
  } else {
    console.error(`diffstalkerd listening on ${options.host ?? '127.0.0.1'}:${options.port}`);
  }
  if (followFile) {
    console.error(`diffstalkerd following ${followFile}`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}, shutting down`);
    daemon
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Nothing to reload yet; treat SIGHUP as a clean shutdown instead of the
  // default terminate-with-129.
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  const crash = (kind: string, err: unknown): void => {
    console.error(`diffstalkerd ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    // Best-effort cleanup (unlinks the socket file); then get out.
    daemon
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on('uncaughtException', (err) => crash('uncaught exception', err));
  process.on('unhandledRejection', (reason) => crash('unhandled rejection', reason));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
