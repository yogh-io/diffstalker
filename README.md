# diffstalker

A terminal UI for git staging, committing, and reviewing changes. Built with TypeScript and Ink (React for CLIs).

## Features

- **Four views**: Diff, Commit, History, and PR comparison
- **Two-pane layout**: File list (top) and diff view (bottom) with resizable split
- **Mouse support**: Click to select, stage/unstage, scroll, switch tabs
- **Word-level diff highlighting**: See exactly what changed within each line
- **6 color themes**: Including colorblind-friendly and ANSI-only variants
- **Follow mode**: Watch a file for paths written by shell hooks
- **AI commit messages**: Generate messages using Claude API (optional)

## Installation

### From source

```bash
git clone https://github.com/user/diffstalker.git
cd diffstalker
npm install
npm run build
npm link  # makes 'diffstalker' available globally
```

### From npm (when published)

```bash
npm install -g diffstalker
```

## Usage

### Basic usage

```bash
# Open current directory
diffstalker

# Open specific repository
diffstalker /path/to/repo
```

### Follow mode

Follow mode watches a file for repository paths, allowing external tools to control which repo is displayed.

```bash
# Follow default file (~/.cache/diffstalker/target)
diffstalker --follow

# Follow custom file
diffstalker --follow /tmp/my-hook-file
```

#### Shell integration

Add to your `.bashrc` or `.zshrc` to auto-update diffstalker when changing directories:

```bash
diffstalker_notify() {
    echo "$PWD" > ~/.cache/diffstalker/target
}
cd() { builtin cd "$@" && diffstalker_notify; }
```

Press `f` at runtime to toggle follow mode on/off.

## Views

### 1. Diff View

The default view showing staged/unstaged files and their diffs.

- **Top pane**: File list organized by status (Modified, Untracked, Staged)
- **Bottom pane**: Diff of selected file with word-level highlighting

### 2. Commit View

Create commits with optional AI-assisted message generation.

- Press `i` or `Enter` to edit the commit message
- Press `a` to toggle amend mode
- Press `g` to generate an AI commit message (requires `ANTHROPIC_API_KEY`)
- Press `Enter` to commit, `Esc` to cancel

### 3. History View

Browse commit history of the current branch.

- Navigate to select commits
- View the diff for any historical commit

### 4. PR View

Compare your current branch against a base branch (useful for reviewing PR changes).

- Press `b` to select a different base branch
- Press `u` to toggle inclusion of uncommitted changes
- Base branch selection is cached per repository

## Keybindings

### Navigation

| Key | Action |
|-----|--------|
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `Tab` | Toggle pane focus |
| `1` | Diff view |
| `2` | Commit view |
| `3` | History view |
| `4` | PR view |

### Staging

| Key | Action |
|-----|--------|
| `Space` / `Enter` | Toggle stage/unstage |
| `Ctrl+S` | Stage selected file |
| `Ctrl+U` | Unstage selected file |
| `Ctrl+A` | Stage all files |
| `Ctrl+Z` | Unstage all files |

### Layout & Appearance

| Key | Action |
|-----|--------|
| `[` | Shrink top pane |
| `]` | Grow top pane |
| `t` | Open theme picker |
| `m` | Toggle scroll/select mode |

### Other

| Key | Action |
|-----|--------|
| `c` | Open commit panel |
| `r` | Refresh |
| `f` | Toggle follow mode |
| `?` | Show keyboard shortcuts |
| `q` / `Ctrl+C` | Quit |

### PR View Specific

| Key | Action |
|-----|--------|
| `b` | Select base branch |
| `u` | Toggle uncommitted changes |

## Mouse

| Action | Effect |
|--------|--------|
| Left-click file | Select file |
| Left-click `[+]` / `[-]` | Stage / unstage file |
| Right-click file | Discard changes (with confirmation) |
| Scroll wheel | Navigate list / scroll diff |
| Click footer tabs | Switch views |

## Themes

Six built-in themes available via `t` key:

| Theme | Description |
|-------|-------------|
| Dark | Default dark theme |
| Light | Light background |
| Dark (colorblind) | Blue/red for deuteranopia |
| Light (colorblind) | Blue/red on light background |
| Dark (ANSI) | Uses terminal's 16 ANSI colors |
| Light (ANSI) | Uses terminal's 16 ANSI colors |

Theme selection is persisted to the config file.

## Configuration

### Config file

Location: `~/.config/diffstalker/config.json`

```json
{
  "theme": "dark",
  "splitRatio": 0.4,
  "targetFile": "~/.cache/diffstalker/target"
}
```

| Option | Type | Description |
|--------|------|-------------|
| `theme` | string | Color theme name |
| `splitRatio` | number | Top/bottom pane split (0.15-0.85) |
| `targetFile` | string | File to watch in follow mode |

### Cache directory

Location: `~/.cache/diffstalker/`

- `target` - Default follow mode file
- `base-branches.json` - Cached PR base branch per repository

### Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for AI commit message generation |
| `DIFFSTALKER_PAGER` | External pager for diff display |

## CLI Options

```
diffstalker [options] [path]

Options:
  -f, --follow [FILE]  Watch file for repo paths (default: ~/.cache/diffstalker/target)
  --once               Show status once and exit
  -d, --debug          Log path changes to stderr
  -h, --help           Show help message

Arguments:
  [path]               Path to a git repository

Examples:
  diffstalker                      Open current directory
  diffstalker /path/to/repo        Open specific repo
  diffstalker --follow             Follow default hook file
  diffstalker -f /tmp/hook         Follow custom hook file
```

## Development

```bash
npm run dev      # Run with hot reload (tsx)
npm run build    # Compile TypeScript
npm start        # Run compiled version
```

See `CLAUDE.md` for architecture details and contribution guidelines.

## License

MIT
