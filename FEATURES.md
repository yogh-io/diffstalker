# Features

## Views

### Diff View (Tab 1)
- File list with staging status (Modified, Untracked, Staged sections)
- Stage/unstage files with `[+]`/`[-]` buttons or keyboard shortcuts
- Side-by-side diff display with word-level highlighting
- Syntax-aware diff coloring

### Commit View (Tab 2)
- Commit message input with multi-line support
- Preview of staged changes
- Amend mode (Ctrl+M)
- AI-assisted commit message generation (requires ANTHROPIC_API_KEY)

### History View (Tab 3)
- Scrollable commit history
- Click or select commit to view its diff
- Shows commit hash, message, date, and refs

### PR View (Tab 4)
- Compare current branch against a base branch
- Shows commits and changed files
- Toggle uncommitted changes inclusion (u key)
- Base branch picker with text filtering (b key)
- Base branch selection cached per repository

## Navigation

### Keyboard
- `↑/k` / `↓/j` - Move up/down
- `Tab` - Toggle between panes
- `1/2/3/4` - Switch tabs
- `Space/Enter` - Toggle stage/unstage
- `?` - Show hotkeys modal

### Mouse
- Click to select files
- Click `[+]`/`[-]` to stage/unstage
- Scroll wheel in panes
- Click tabs in footer to switch
- Right-click to discard changes (with confirmation)

### Mouse Modes
- `m` - Toggle between scroll mode and select mode

## Staging Operations
- `Ctrl+S` - Stage selected file
- `Ctrl+U` - Unstage selected file
- `Ctrl+A` - Stage all files
- `Ctrl+Z` - Unstage all files

## Layout
- `[` / `]` - Resize panes (shrink/grow top pane)
- Split ratio persisted to config

## Appearance
- `t` - Theme picker
- 6 built-in themes: dark, light, dark-colorblind, light-colorblind, dark-ansi, light-ansi
- Theme preference persisted to config

## Follow Mode
- `--follow` CLI flag to watch a file for repo path changes
- `f` - Toggle follow mode at runtime
- Shows follow status in header when enabled
- Useful for integration with shell hooks

## Path Shortening
- Long file paths automatically shortened with ellipsis
- Keeps first directory and filename visible
- Applied throughout the UI (file list, diff headers, PR view)

## Configuration
- Config file: `~/.config/diffstalker/config.json`
- Cache directory: `~/.cache/diffstalker/`
- Base branch cache: `~/.cache/diffstalker/base-branches.json`
- Follow target file: `~/.cache/diffstalker/target` (default)

## Other
- `r` / `Ctrl+R` - Refresh
- `c` - Open commit panel
- `q` / `Ctrl+C` - Quit
- Terminal cleanup on exit (mouse mode disabled, cursor restored)
