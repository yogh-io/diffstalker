#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config.js';

// Cleanup function to reset terminal state
function cleanupTerminal(): void {
  // Disable any mouse tracking
  process.stdout.write('\x1b[?1006l');
  process.stdout.write('\x1b[?1002l');
  process.stdout.write('\x1b[?1000l');
  // Show cursor
  process.stdout.write('\x1b[?25h');
}

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
  follow?: boolean;        // --follow was specified
  followFile?: string;     // Custom file for --follow (optional)
  initialPath?: string;    // Positional path argument
  once?: boolean;
  debug?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--follow' || arg === '-f') {
      result.follow = true;
      // Check if next arg is a path (not another flag)
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        result.followFile = args[++i];
      }
    } else if (arg === '--once') {
      result.once = true;
    } else if (arg === '--debug' || arg === '-d') {
      result.debug = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
diffstalker - Terminal git diff/status viewer

Usage: diffstalker [options] [path]

Options:
  -f, --follow [FILE]  Follow hook file for dynamic repo switching
                       (default: ~/.cache/diffstalker/target)
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
  j/k, ↑/↓    Navigate files / scroll diff
  Ctrl+S      Stage selected file
  Ctrl+U      Unstage selected file
  Ctrl+A      Stage all files
  Ctrl+Z      Unstage all files
  Enter/Space Toggle stage/unstage
  Tab         Switch between panes
  1/2         Switch bottom tab (Diff/Commit)
  c           Open commit panel
  r           Refresh
  q / Ctrl+C  Quit

Mouse:
  Click       Select file / focus pane
  Click [+/-] Stage/unstage file
  Scroll      Navigate files / scroll diff
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      result.initialPath = arg;
    }
  }

  return result;
}

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

// Render the app
const { waitUntilExit } = render(
  <App config={config} initialPath={args.initialPath} />
);

waitUntilExit().then(() => {
  process.exit(0);
});
