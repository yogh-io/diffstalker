# Features

A comprehensive list of diffstalker features organized by category.

## Views

### Diff View (Tab 1)
- File list organized by status: Modified, Untracked, Staged
- Stage/unstage files with `[+]`/`[-]` buttons or keyboard shortcuts
- Side-by-side diff display with word-level highlighting
- Syntax-aware diff coloring based on selected theme

### Commit View (Tab 2)
- Commit message input with vim-style `i` to enter edit mode
- Toggle amend mode with `a` key
- Shows count of staged files

### History View (Tab 3)
- Scrollable commit history for current branch
- Shows commit hash, message, date, and refs
- Select commit to view its diff in bottom pane

### PR View (Tab 4)
- Compare current branch against a configurable base branch
- Shows list of commits and changed files
- Toggle uncommitted changes inclusion with `u` key
- Base branch picker with fuzzy text filtering (`b` key)
- Base branch selection cached per repository

### Explorer View (Tab 5)
- Read-only file browser for the repository
- Breadcrumb navigation showing current path
- Flat directory listing sorted: directories first, then files
- Respects `.gitignore` (gitignored files are hidden)
- File content viewer in bottom pane
- Binary file detection (shows "Binary file - cannot display")
- Large file handling (warns >100KB, truncates >1MB)
- Navigation: `Enter` to enter directory, `Backspace`/`h` to go up

## Navigation

### Keyboard
| Key | Action |
|-----|--------|
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `Tab` | Toggle between panes |
| `1` / `2` / `3` / `4` / `5` | Switch tabs |
| `Space` / `Enter` | Toggle stage/unstage |
| `?` | Show hotkeys modal |

### Mouse
| Action | Effect |
|--------|--------|
| Click file | Select file |
| Click `[+]` / `[-]` | Stage / unstage file |
| Right-click file | Discard changes (with confirmation) |
| Scroll wheel | Navigate list or scroll diff |
| Click footer tabs | Switch views |

### Mouse Modes
- `m` - Toggle between scroll mode and select mode
- Scroll mode: scrolling always scrolls, doesn't change selection
- Select mode: scrolling changes selection in file list

## Staging Operations

| Key | Action |
|-----|--------|
| `Ctrl+S` | Stage selected file |
| `Ctrl+U` | Unstage selected file |
| `Ctrl+A` | Stage all files |
| `Ctrl+Z` | Unstage all files |

## Layout

- `[` / `]` - Resize panes (shrink/grow top pane)
- Split ratio persisted to config (range: 0.15 to 0.85)
- Dynamic header height when follow mode indicator is shown

## Appearance

- `t` - Open theme picker
- 6 built-in themes:
  - **Dark** - Default dark theme (sampled from Claude Code)
  - **Light** - Light background variant
  - **Dark (colorblind)** - Blue/red color scheme for deuteranopia
  - **Light (colorblind)** - Blue/red on light background
  - **Dark (ANSI)** - Uses terminal's native 16 ANSI colors
  - **Light (ANSI)** - ANSI colors on light background
- Theme preference persisted to config

## Follow Mode

- `--follow` CLI flag to watch a file for repository paths
- `f` - Toggle follow mode at runtime
- Shows follow status in header when enabled
- Header gracefully degrades if follow path is too long to display
- Useful for integration with shell hooks (e.g., update on `cd`)

## Path Display

- Long file paths automatically shortened with ellipsis
- Keeps first directory and filename visible
- Applied throughout the UI: file list, diff headers, PR view

## Configuration

### Config File
Location: `~/.config/diffstalker/config.json`

| Option | Type | Description |
|--------|------|-------------|
| `theme` | string | Selected theme name |
| `splitRatio` | number | Top/bottom pane split ratio |
| `targetFile` | string | File to watch in follow mode |

### Cache Directory
Location: `~/.cache/diffstalker/`

| File | Purpose |
|------|---------|
| `target` | Default follow mode hook file |
| `base-branches.json` | PR base branch cache per repository |

## Other Commands

| Key | Action |
|-----|--------|
| `c` | Open commit panel |
| `r` / `Ctrl+R` | Refresh git status |
| `q` / `Ctrl+C` | Quit |

## Technical Notes

- Mouse tracking uses SGR extended mode for accurate coordinates
- Terminal cleanup on exit (mouse mode disabled, cursor restored)
- Handles SIGINT, SIGTERM, and uncaught exceptions gracefully
- Mouse tracking automatically disabled when text inputs are focused
