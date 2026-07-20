#!/usr/bin/env node
import { App } from './App.js';
import { loadConfig, resolveFollowFile } from './config.js';
import { ensureDaemon } from './daemon/DaemonLifecycle.js';
import { setDebug } from '@diffstalker/core/utils/logger';

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
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--follow' || arg === '-f') {
      result.follow = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        result.followFile = args[++i];
      }
    } else if (arg === '--debug' || arg === '-d') {
      result.debug = true;
    } else if (arg === '--socket' || arg === '-s') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        result.socket = args[++i];
      } else {
        console.error('Error: --socket requires a path argument');
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
diffstalker - Terminal git diff/status viewer

Usage: diffstalker [options] [path]

Options:
  -f, --follow [FILE]  Follow hook file for dynamic repo switching
                       (default: ~/.cache/diffstalker/target)
  -s, --socket PATH    diffstalkerd socket to attach to or spawn on
                       (default: $DIFFSTALKER_SOCKET, then
                       $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock)
  -d, --debug          Log path changes to stderr for debugging
  -h, --help           Show this help message

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
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
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
    ({ client } = await ensureDaemon({ socketPath: args.socket, followFile }));
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
      ensureDaemon({ socketPath: args.socket, followFile }).then((r) => r.client),
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
