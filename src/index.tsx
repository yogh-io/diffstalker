#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { loadConfig } from './config.js';

// Cleanup function to reset terminal state (especially mouse mode)
function cleanupTerminal(): void {
  // Disable mouse tracking
  process.stdout.write('\x1b[?1006l'); // Disable SGR extended mode
  process.stdout.write('\x1b[?1002l'); // Disable mouse drag tracking
  process.stdout.write('\x1b[?1000l'); // Disable mouse click tracking
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
function parseArgs(args: string[]): { targetFile?: string; initialPath?: string; once?: boolean } {
  const result: { targetFile?: string; initialPath?: string; once?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--target-file' && args[i + 1]) {
      result.targetFile = args[++i];
    } else if (arg === '--once') {
      result.once = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
diffstalker - Terminal git diff/status viewer

Usage: diffstalker [options] [path]

Options:
  --target-file PATH   Override the watched file path
                       (default: ~/.cache/diffstalker/target)
  --once               Show status once and exit
  -h, --help           Show this help message

Arguments:
  [path]               Optional path to a git repository

Environment:
  DIFFSTALKER_PAGER       External pager for diff display
  DIFFSTALKER_TARGET_FILE Override watched file path

Examples:
  diffstalker                           # Watch for paths
  diffstalker ~/projects/myrepo         # Show specific repo
  echo ~/myrepo > ~/.cache/diffstalker/target  # Trigger update

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

// Override config with CLI args
if (args.targetFile) {
  config.targetFile = args.targetFile;
}

// Render the app
const { waitUntilExit } = render(
  <App config={config} initialPath={args.initialPath} />
);

waitUntilExit().then(() => {
  process.exit(0);
});
