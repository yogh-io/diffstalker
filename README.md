# diffstalker

A terminal UI for git staging and committing, designed to receive paths from external tools.

![diffstalker screenshot](https://github.com/user/diffstalker/assets/screenshot.png)

## Features

- **Two-pane layout**: Staging area (top) and diff view (bottom)
- **Mouse support**: Click to select files, click `[+]/[-]` to stage/unstage, scroll to navigate
- **Push-based architecture**: Receives paths via file watching, integrates with shell hooks
- **AI commit messages**: Generate commit messages using Claude API (optional)
- **Real-time updates**: Watches `.git` directory for external changes

## Installation

### From npm

```bash
npm install -g diffstalker
```

### From AUR (Arch Linux)

```bash
yay -S diffstalker-git
```

### From source

```bash
git clone https://github.com/user/diffstalker.git
cd diffstalker
npm install
npm run build
npm link  # or: sudo npm install -g .
```

## Usage

### Direct path

```bash
diffstalker /path/to/repo
```

### Watch mode (default)

```bash
diffstalker
```

In watch mode, diffstalker monitors `~/.cache/diffstalker/target` for paths written by external tools.

### Shell integration

Add to your `.bashrc` or `.zshrc`:

```bash
diffstalker_notify() {
    echo "$PWD" > ~/.cache/diffstalker/target
}
cd() { builtin cd "$@" && diffstalker_notify; }
```

Now diffstalker updates whenever you `cd` into a git repository.

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+S` | Stage selected file |
| `Ctrl+U` | Unstage selected file |
| `Ctrl+A` | Stage all files |
| `Ctrl+Z` | Unstage all files |
| `j/k` or `Up/Down` | Navigate files / scroll diff |
| `Tab` | Switch between panes |
| `Enter` or `Space` | Toggle stage/unstage |
| `1` / `2` | Switch to Diff / Commit tab |
| `c` | Open commit panel |
| `g` | Generate AI commit message (in commit panel) |
| `r` | Refresh |
| `q` | Quit |

## Mouse

| Action | Effect |
|--------|--------|
| Left-click file | Select file |
| Left-click `[+]/[-]` | Stage/unstage file |
| Right-click file | Discard changes (with confirmation) |
| Scroll | Navigate file list / scroll diff |

## Configuration

### Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for AI commit message generation |
| `DIFFSTALKER_TARGET_FILE` | Override watched file path |

### Config file

`~/.config/diffstalker/config.json`:

```json
{
  "targetFile": "~/.cache/diffstalker/target"
}
```

## CLI Options

```
diffstalker [options] [path]

Options:
  --target-file PATH   Override the watched file path
  --once               Show status once and exit
  -h, --help           Show help message

Arguments:
  [path]               Path to a git repository
```

## AI Commit Messages

Set your Anthropic API key to enable AI-generated commit messages:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

In the commit panel, press `g` to generate a commit message based on your staged changes.

## Architecture

```
External tools                    diffstalker
─────────────────                ────────────────────────────────
                                 ┌─────────────────────────────┐
shell cd hook ──┐                │  Watch ~/.cache/diffstalker │
tmux hook ──────┼──► write to ──►│  /target file               │
custom script ──┘    file        │                             │
                                 │  On change:                 │
                                 │  1. Read path               │
                                 │  2. git status/diff         │
                                 │  3. Render TUI              │
                                 └─────────────────────────────┘
```

## Development

```bash
# Run in development mode (with hot reload)
npm run dev

# Build
npm run build

# Run built version
npm start
```

## License

MIT
