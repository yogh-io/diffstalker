#!/usr/bin/env node
import { App } from './App.js';
import { loadConfig } from './config.js';
import { CommandServer } from './ipc/CommandServer.js';

// Cleanup function to reset terminal state on exit
function cleanupTerminal(): void {
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
  once?: boolean;
  debug?: boolean;
  socket?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--follow' || arg === '-f') {
      result.follow = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        i++;
        result.followFile = args[i];
      }
    } else if (arg === '--once') {
      result.once = true;
    } else if (arg === '--debug' || arg === '-d') {
      result.debug = true;
    } else if (arg === '--socket' || arg === '-s') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        i++;
        result.socket = args[i];
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
  -s, --socket PATH    Enable IPC server on Unix socket for testing
  --once               Show status once and exit
  -d, --debug          Log path changes to stderr for debugging
  -h, --help           Show this help message

Arguments:
  [path]               Path to a git repository (fixed, no watching)

Modes:
  diffstalker                     Fixed on current directory
  diffstalker /path/to/repo       Fixed on specified repo
  diffstalker --follow            Follow default hook file
  diffstalker --follow /tmp/hook  Follow custom hook file

Environment:
  DIFFSTALKER_PAGER       External pager for diff display

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
  r             Refresh
  q / Ctrl+C    Quit

Mouse:
  Click         Select file / focus pane
  Scroll        Navigate files / scroll diff
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      result.initialPath = arg;
    }
    i++;
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Configure watcher based on --follow flag
  if (args.follow) {
    config.watcherEnabled = true;
    if (args.followFile) {
      config.targetFile = args.followFile;
    }
  }
  if (args.debug) {
    config.debug = true;
  }

  // Start IPC server if --socket specified
  let commandServer: CommandServer | null = null;
  if (args.socket) {
    commandServer = new CommandServer(args.socket);
    try {
      await commandServer.start();
    } catch (err) {
      console.error('Failed to start command server:', err);
      process.exit(1);
    }
  }

  // Create and start the app
  const app = new App({
    config,
    initialPath: args.initialPath,
    commandServer,
  });

  // Wait for app to exit
  await app.start();

  // Clean up command server
  if (commandServer) {
    commandServer.stop();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  cleanupTerminal();
  process.exit(1);
});
