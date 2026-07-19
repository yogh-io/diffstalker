/**
 * diffstalkerd entry point: parse CLI args, start the daemon, and shut
 * down cleanly on SIGINT/SIGTERM.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, ListenOptions } from './server.js';

const HELP = `diffstalkerd — diffstalker daemon (REST API + SSE over @diffstalker/core)

Usage: diffstalkerd [options]

Options:
  --socket PATH   Bind a unix socket at PATH (default: <tmpdir>/diffstalkerd.sock)
  --port N        Bind TCP port N instead of a unix socket
  --host H        Host to bind with --port (default: 127.0.0.1)
  --help, -h      Show this help
`;

function expectValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): ListenOptions | 'help' {
  const options: ListenOptions = {};

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
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.socketPath !== undefined && options.port !== undefined) {
    throw new Error('--socket and --port are mutually exclusive');
  }
  if (options.socketPath === undefined && options.port === undefined) {
    options.socketPath = path.join(os.tmpdir(), 'diffstalkerd.sock');
  }
  return options;
}

async function main(): Promise<void> {
  let options: ListenOptions | 'help';
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

  const daemon = createDaemon();
  await daemon.listen(options);
  if (options.socketPath) {
    console.log(`diffstalkerd listening on unix socket ${options.socketPath}`);
  } else {
    console.log(`diffstalkerd listening on ${options.host ?? '127.0.0.1'}:${options.port}`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
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
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
