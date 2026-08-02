#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { App } from './App.js';
import { loadConfig, resolveFollowFile } from './config.js';
import { ensureDaemon, resolveDaemonBin } from './daemon/DaemonLifecycle.js';
import { setDebug } from '@diffstalker/core/utils/logger';
// Default import, not `{ version }`: a JSON module has only a default export,
// so the named form throws under Node — and bin/diffstalker runs the compiled
// dist under Node (see the same note in ui/modals/HotkeysModal.ts).
import manifest from '../package.json' with { type: 'json' };

const { version } = manifest;

/**
 * Answer --version with the number AND the paths behind it. npm, `bun link`
 * and the AUR package all plant a `diffstalker` and a `diffstalkerd` that
 * shadow each other, so "which one is this" is the real question here.
 */
function printVersion(): void {
  let daemonBin: string;
  try {
    daemonBin = resolveDaemonBin();
  } catch {
    // Not an error to report: which daemon this install would spawn is part
    // of the answer, and "none" is a true answer.
    daemonBin = 'not found';
  }
  console.log(
    `diffstalker ${version}\n` +
      `  cli:     ${fileURLToPath(import.meta.url)}\n` +
      `  daemon:  ${daemonBin}\n` +
      `  runtime: ${process.execPath}`
  );
}

// --version is answered before the terminal escape codes below are written,
// so the output is clean on a pipe, and before any daemon is contacted, so
// it still answers when no daemon can start.
const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
  printVersion();
  process.exit(0);
}

// Cleanup function to reset terminal state on exit
function cleanupTerminal(): void {
  // Leave the alternate screen buffer first, so anything printed after
  // cleanup (crash diagnostics) lands on the normal buffer instead of
  // being discarded with the alternate one
  process.stdout.write('\x1b[?1049l');
  // Disable SGR extended mouse mode
  process.stdout.write('\x1b[?1006l');
  // Disable button event mouse tracking
  process.stdout.write('\x1b[?1002l');
  // Disable basic mouse tracking
  process.stdout.write('\x1b[?1000l');
  // Disable any-event mouse tracking (in case it was enabled)
  process.stdout.write('\x1b[?1003l');
  // Show cursor
  process.stdout.write('\x1b[?25h');
}

// Clean up any leftover mouse state from previous crashes
cleanupTerminal();

// Ensure terminal is cleaned up on any exit
process.on('exit', cleanupTerminal);
process.on('SIGINT', () => {
  cleanupTerminal();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupTerminal();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  cleanupTerminal();
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  cleanupTerminal();
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Parse CLI arguments
interface ParsedArgs {
  follow?: boolean;
  followFile?: string;
  initialPath?: string;
  debug?: boolean;
  socket?: string;
  instance?: string;
}

/**
 * Report a bad command line and stop. Exit code 2 matches diffstalkerd, so
 * both binaries answer the same mistake the same way.
 */
function usageError(message: string): never {
  console.error(`diffstalker: ${message}`);
  console.error("Run 'diffstalker --help' for the option list.");
  process.exit(2);
}

/**
 * An unrecognised flag is an error, never a repo path. `--port 7337` used to
 * be read as "open the repo at ./7337" — a silent misreading of a flag the
 * daemon does have.
 */
function unknownOption(arg: string): never {
  if (arg === '--port' || arg === '-p') {
    usageError(
      `unknown option ${arg}. The TUI reaches diffstalkerd over a unix socket; the\n` +
        '  web UI is the daemon\'s, so give the port to it: `diffstalkerd --port N`.\n' +
        '  A daemon already holding the socket must be stopped first, or the new one\n' +
        '  started as `diffstalkerd --port N --instance NAME` (then run diffstalker\n' +
        '  --instance NAME to share it).'
    );
  }
  usageError(`unknown option ${arg}`);
}

const HELP = `
diffstalker - Terminal git diff/status viewer

Usage: diffstalker [options] [path]

Options:
  -f, --follow [FILE]  Follow hook file for dynamic repo switching
                       (default: ~/.cache/diffstalker/target)
  -s, --socket PATH    diffstalkerd socket to attach to or spawn on
                       (default: $DIFFSTALKER_SOCKET, then --instance, then
                       $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock)
      --instance NAME  Attach to the daemon named NAME (<NAME>.sock in the
                       runtime dir), spawning it if absent. The client half
                       of diffstalkerd --instance; $DIFFSTALKER_INSTANCE
                       sets it too.
  -d, --debug          Log path changes to stderr for debugging
  -h, --help           Show this help message
  -v, --version        Print the version, plus which cli/daemon binaries
                       this install actually runs, and exit

Arguments:
  [path]               Path to a git repository (fixed, no watching)

Modes:
  diffstalker                     Fixed on current directory
  diffstalker /path/to/repo       Fixed on specified repo
  diffstalker --follow            Follow default hook file
  diffstalker --follow /tmp/hook  Follow custom hook file

The TUI talks to diffstalkerd (spawned automatically when not already
running; found via DIFFSTALKERD_BIN, PATH, or the workspace checkout).
The daemon outlives the TUI and is never stopped by it.

Keyboard:
  j/k, Up/Down  Navigate files / scroll diff
  s             Stage selected file
  Shift+u       Unstage selected file
  Shift+a       Stage all files
  Shift+z       Unstage all files
  Enter/Space   Toggle stage/unstage
  Tab           Switch between panes
  1/2/3/4/5     Switch tabs (Diff/Commit/History/Compare/Explorer)
  c             Open commit panel
  r             Open repo picker
  q / Ctrl+C    Quit

Mouse:
  Click         Select file / focus pane
  Scroll        Navigate files / scroll diff
`;

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // A value must not look like a flag: `--socket --debug` is a missing
    // path, not a socket named --debug.
    const value = args[i + 1] !== undefined && !args[i + 1].startsWith('-') ? args[i + 1] : null;

    switch (arg) {
      case '--follow':
      case '-f':
        result.follow = true;
        // FILE is optional here: bare --follow means the daemon's own target.
        if (value !== null) {
          result.followFile = value;
          i++;
        }
        break;
      case '--debug':
      case '-d':
        result.debug = true;
        break;
      case '--instance':
        if (value === null) usageError('--instance requires a name');
        result.instance = value;
        i++;
        break;
      case '--socket':
      case '-s':
        if (value === null) usageError(`${arg} requires a path`);
        result.socket = value;
        i++;
        break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) unknownOption(arg);
        // Two paths means one of them was going to be ignored in silence.
        if (result.initialPath !== undefined) {
          usageError(`unexpected extra argument ${arg} (one repo path at a time)`);
        }
        result.initialPath = arg;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // --follow is client policy now: the daemon owns the hook-file watcher, so
  // this only enables the TUI's reaction to its follow-change events. An
  // explicit FILE is passed through to a daemon we spawn, and validated
  // against a daemon we attach to (ensureDaemon), never a local watcher.
  if (args.follow) {
    config.watcherEnabled = true;
  }
  if (args.debug) {
    config.debug = true;
  }
  // Debug can come from --debug or a persisted config.debug.
  if (config.debug) {
    setDebug(true);
  }

  // Which hook file the daemon should follow (see resolveFollowFile): an
  // explicit --follow FILE, else a persisted non-default config target when
  // follow is on, else implicit (the daemon's default).
  const followFile = resolveFollowFile(config, args.followFile);

  // Attach to (or spawn) diffstalkerd before the screen exists, so any
  // failure prints on the normal buffer.
  let client;
  try {
    ({ client } = await ensureDaemon({ socketPath: args.socket, followFile, instance: args.instance }));
  } catch (err) {
    console.error(
      `Failed to reach diffstalkerd: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // Create and start the app. `reconnect` re-runs ensureDaemon when a
  // session loses its connection: it spawns a fresh daemon if the socket is
  // gone, or re-attaches if one came back, so a mid-session daemon restart
  // reconnects silently instead of throwing/printing ENOENT into the screen.
  const app = new App({
    config,
    client,
    initialPath: args.initialPath,
    reconnect: () =>
      ensureDaemon({ socketPath: args.socket, followFile, instance: args.instance }).then((r) => r.client),
  });

  // Wait for app to exit
  await app.start();

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  cleanupTerminal();
  process.exit(1);
});
