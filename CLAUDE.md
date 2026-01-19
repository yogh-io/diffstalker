# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

diffstalker is a terminal UI for git staging and committing, built with TypeScript and Ink (React for CLIs). It follows a push-based architecture where external tools write repository paths to a watched file.

## Feature Documentation

**IMPORTANT:** After adding a new feature, update `FEATURES.md` to document it. Keep the feature list organized by category (Views, Navigation, Operations, etc.).

## Tech Stack

- **TypeScript** with ESM modules
- **Ink v6** (React for terminal UIs)
- **React 19** hooks for state management
- **chokidar** for file watching
- **simple-git** for git operations
- **@anthropic-ai/sdk** for AI commit messages (optional)
- **fast-diff** for word-level diff highlighting

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
├── config.ts           # Configuration loading and saving
├── themes.ts           # Theme definitions (6 themes)
├── components/
│   ├── Header.tsx      # Repo path, branch info, follow status
│   ├── FileList.tsx    # Staging area file list
│   ├── DiffView.tsx    # Diff display with word-level highlighting
│   ├── CommitPanel.tsx # Commit message input UI
│   ├── Footer.tsx      # Keybinding hints and tab bar
│   ├── HistoryView.tsx # Commit history list
│   ├── PRListView.tsx  # PR commits and files list
│   ├── PRView.tsx      # PR diff container
│   ├── Modal.tsx       # Reusable modal overlay component
│   ├── BaseBranchPicker.tsx  # Modal for selecting PR base branch
│   ├── ThemePicker.tsx # Modal for selecting theme
│   └── HotkeysModal.tsx # Keyboard shortcuts reference
├── hooks/
│   ├── useGit.ts       # Git state management, operations
│   ├── useWatcher.ts   # File watching for target path
│   ├── useKeymap.ts    # Keyboard handling
│   ├── useMouse.ts     # Mouse event parsing (SGR mode)
│   ├── useLayout.ts    # Pane sizing and scroll management
│   ├── useCommitFlow.ts # Commit panel state machine
│   └── useTerminalSize.ts # Terminal resize handling
├── core/
│   ├── GitStateManager.ts   # Git state management (non-React)
│   └── GitOperationQueue.ts # Serializes git operations
├── services/
│   └── commitService.ts # Git commit execution
├── git/
│   ├── status.ts       # Git status operations
│   └── diff.ts         # Diff generation
├── utils/
│   ├── baseBranchCache.ts  # Cache for PR base branch per repo
│   ├── formatPath.ts       # Path shortening utility
│   ├── layoutCalculations.ts # UI layout math
│   └── mouseCoordinates.ts # Mouse position calculations
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

### Modals
Ink doesn't have native modal support. Modals are implemented by:
1. Rendering modal last (render order = z-order)
2. Using `position="absolute"` with calculated x/y offsets
3. The `Modal` component blankets its own area with spaces before rendering content
4. Mouse tracking is disabled when text inputs within modals are focused

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

### Adding a modal
1. Create component using `<Modal x={x} y={y} width={w} height={h}>`
2. Use `centerModal()` helper to calculate position
3. Add state in `App.tsx` (e.g., `showMyModal`)
4. If modal has text input, add it to `mouseDisabled` condition in `App.tsx`
5. Render modal last in the JSX (after other content)

## Gotchas

- Mouse coordinates from terminals are 1-indexed
- `simple-git` status may include gitignored files in some cases; we filter with `git check-ignore`
- Ink's flexbox can add padding if container height doesn't match content; keep `LAYOUT_OVERHEAD` accurate

## Code Quality Guidelines

### Single Source of Truth for Layout/Row Calculations
When building UI structures with rows (like diff views, file lists, PR views):
- **Always use a single exported function** to build/count rows (e.g., `buildPRDiffRows()`)
- The same function must be used for both rendering and scroll calculations
- Never duplicate row-counting logic inline - if rendering adds headers/separators, scroll max calculation must use the same logic
- Example: `PRView.tsx` exports `buildPRDiffRows()` which is used by the component itself, `getFileScrollOffset()`, and `getPRDiffTotalRows()`

This prevents subtle bugs where scroll limits don't match actual content, or click detection is off by N rows because header count changed.
