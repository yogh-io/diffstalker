# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

diffstalker is a terminal UI for git staging and committing, built with TypeScript and Ink (React for CLIs). It follows a push-based architecture where external tools write repository paths to a watched file.

## Tech Stack

- **TypeScript** with ESM modules
- **Ink v5** (React for terminal UIs)
- **React 18** hooks for state management
- **chokidar** for file watching
- **simple-git** for git operations
- **@anthropic-ai/sdk** for AI commit messages (optional)

## Build Commands

```bash
npm run dev    # Run with tsx (development, hot reload)
npm run build  # Compile TypeScript to dist/
npm start      # Run compiled version
```

## Project Structure

```
src/
├── index.tsx           # Entry point, CLI args, terminal cleanup
├── App.tsx             # Main component, layout, mouse handling
├── config.ts           # Configuration loading
├── components/
│   ├── Header.tsx      # Repo path, branch info
│   ├── FileList.tsx    # Staging area file list
│   ├── DiffView.tsx    # Diff display
│   ├── CommitPanel.tsx # Commit message input
│   └── Footer.tsx      # Keybinding hints
├── hooks/
│   ├── useGit.ts       # Git state management, operations
│   ├── useWatcher.ts   # File watching for target path
│   ├── useKeymap.ts    # Keyboard handling
│   ├── useMouse.ts     # Mouse event parsing (SGR mode)
│   └── useTerminalSize.ts # Terminal resize handling
├── git/
│   ├── status.ts       # Git status operations
│   └── diff.ts         # Diff generation
└── ai/
    └── commit.ts       # AI commit message generation
```

## Key Patterns

### Mouse Events
Mouse handling uses SGR extended mode for accurate coordinates. Events are parsed in `useMouse.ts` and handled in `App.tsx`. The mouse handler calculates which file was clicked based on terminal row positions.

### Git Operations
All git operations go through `useGit.ts` which wraps functions from `git/status.ts` and `git/diff.ts`. Operations have error handling that displays errors in the UI rather than crashing.

### Terminal Cleanup
`index.tsx` registers handlers for `exit`, `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection` to ensure mouse mode is disabled on any exit.

### Layout
Layout uses a fixed overhead calculation (`LAYOUT_OVERHEAD = 5`) for header, separators, and footer. The remaining space is split 40/60 between the staging area and diff view.

## Common Tasks

### Adding a new git operation
1. Add the function to `src/git/status.ts`
2. Import and wrap it in `src/hooks/useGit.ts` with error handling
3. Add to the `UseGitResult` interface and return object
4. Use in `App.tsx` or components

### Adding a keybinding
1. Add handler in `src/hooks/useKeymap.ts`
2. Pass callback from `App.tsx`
3. Update `Footer.tsx` to show the hint

### Adding mouse interaction
1. Handle in `handleMouseEvent` callback in `App.tsx`
2. Calculate boundaries based on `topPaneHeight`, `bottomPaneHeight`

## Gotchas

- Mouse coordinates from terminals are 1-indexed
- `simple-git` status may include gitignored files in some cases; we filter with `git check-ignore`
- Ink's flexbox can add padding if container height doesn't match content; keep `LAYOUT_OVERHEAD` accurate
