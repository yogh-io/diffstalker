# diffstalker

Keep your changes visible. A terminal-based git UI designed to run on a secondary monitor, automatically tracking whichever repository you're working in.

<!-- Screenshots will go here -->

## Why diffstalker?

**Keep up with AI.** When AI assistants edit your code, changes happen fast. diffstalker gives you a live view of what's being modified, so you can review changes as they happen rather than piecing things together afterward.

**Always-on visibility.** Put diffstalker on your second monitor and forget about it. As you switch between projects, it follows along—showing your current changes, staged files, and diffs without you ever needing to alt-tab or type `git status`.

**Dead-simple integration.** Follow mode watches a plain text file for paths. Any script, hook, or tool can write to it. Add two lines to your shell config and every `cd` into a git repo updates the display automatically.

**Everything at a glance.** Auto-tab mode ensures there's always something useful on screen—uncommitted changes when you have them, recent commits when you don't. Word-level diff highlighting shows exactly what changed, not just which lines.

## Features

- **Follow mode** — Automatically tracks repos via a simple file-based hook
- **Auto-tab** — Always shows relevant content (changes → history → PR diff)
- **Word-level diffs** — See precise changes within each line
- **Four views** — Diff, Commit, History, and PR comparison
- **Mouse & keyboard** — Click, scroll, or use vim-style navigation
- **6 themes** — Including colorblind-friendly and ANSI-only variants

## Installation

```bash
npm install -g diffstalker
```

Or from source:
```bash
git clone https://github.com/yogh-io/diffstalker.git
cd diffstalker
npm install && npm run build:prod
npm link
```

## Quick Start

**Basic usage:**
```bash
diffstalker              # current directory
diffstalker /path/to/repo
```

**Follow mode** (recommended for secondary monitor):
```bash
diffstalker --follow
```

Follow mode watches `~/.cache/diffstalker/target` for repository paths. Write or append to this file—diffstalker reads the last non-empty line, so both styles work:

### Integration Examples

**Shell hook** — update on every `cd`:
```bash
# Add to .bashrc or .zshrc
diffstalker_notify() {
    [[ -d .git ]] && echo "$PWD" > ~/.cache/diffstalker/target
}
cd() { builtin cd "$@" && diffstalker_notify; }
```

**Tmux** — update on pane/window switch:
```bash
# In .tmux.conf
set-hook -g pane-focus-in 'run-shell "tmux display -p \"#{pane_current_path}\" > ~/.cache/diffstalker/target"'
```

**Neovim** — update when changing buffers:
```lua
-- In init.lua
vim.api.nvim_create_autocmd({"BufEnter"}, {
  callback = function()
    local root = vim.fn.finddir('.git/..', vim.fn.expand('%:p:h') .. ';')
    if root ~= '' then
      local f = io.open(os.getenv('HOME') .. '/.cache/diffstalker/target', 'w')
      if f then f:write(vim.fn.fnamemodify(root, ':p:h')); f:close() end
    end
  end
})
```

**Any script** — write or append:
```bash
echo "/path/to/repo" > ~/.cache/diffstalker/target   # overwrite
echo "/path/to/repo" >> ~/.cache/diffstalker/target  # append (also works)
```

The file-based approach is intentionally simple. IDE plugins, window manager hooks, project switchers, git hooks—if it can write to a file, it can drive diffstalker. Get creative.

## Views

| View | Key | Purpose |
|------|-----|---------|
| **Diff** | `1` | Stage/unstage files, review changes |
| **Commit** | `2` | Write commit messages |
| **History** | `3` | Browse recent commits and their diffs |
| **PR** | `4` | Compare branch against base (main/master) |

## Keybindings

**Navigation:** `↑↓` or `jk` to move, `Tab` to switch panes, `1-4` for views

**Staging:** `Space` toggle, `Ctrl+A` stage all, `Ctrl+Z` unstage all

**Other:** `t` themes, `?` help, `q` quit

Full keybinding reference available with `?` in the app.

## Themes

Six built-in themes (`t` to switch):

| Theme | Description |
|-------|-------------|
| Dark | Default |
| Light | Light background |
| Dark/Light (colorblind) | Blue/red palette |
| Dark/Light (ANSI) | Terminal's 16 colors |

## Configuration

Config: `~/.config/diffstalker/config.json`

```json
{
  "theme": "dark",
  "splitRatio": 0.4,
  "targetFile": "~/.cache/diffstalker/target"
}
```

## CLI Options

```
diffstalker [options] [path]

Options:
  -f, --follow [FILE]  Watch file for repo paths
  --once               Show status once and exit
  -d, --debug          Log path changes to stderr
  -h, --help           Show help
```

## License

MIT
