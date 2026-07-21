# diffstalker

A terminal git UI that lives on your second monitor. It watches your repositories in real time, follows you as you switch projects, and shows word-level diffs so you always know exactly what changed.

![diffstalker diff view](https://raw.githubusercontent.com/yogh-io/diffstalker/main/assets/diff.png)
*Stage files and review changes with word-level diff highlighting.*

![diffstalker history view](https://raw.githubusercontent.com/yogh-io/diffstalker/main/assets/history.png)
*Browse commit history and inspect past changes.*

## Why diffstalker?

**Keep up with AI.** When AI assistants edit your code, changes happen fast. diffstalker gives you a live view of what's being modified, so you can review changes as they happen rather than piecing things together afterward.

**Always-on visibility.** Put it on your second monitor and forget about it. As you switch between projects, diffstalker follows along - showing your current changes, staged files, and diffs without you ever needing to alt-tab or type `git status`.

**Dead-simple integration.** Follow mode watches a plain text file for paths. Any script, hook, or tool can write to it. Add two lines to your shell config and every `cd` into a git repo updates the display automatically.

**Everything at a glance.** Auto-tab mode ensures there's always something useful on screen - uncommitted changes when you have them, recent commits when you don't.

## Features

- **Five views** - Staging, Commit, History, PR comparison, and a file Explorer with syntax-highlighted preview
- **Word-level diffs** - See exactly which words changed within each line, not just which lines differ
- **Follow mode** - Automatically tracks whichever repo you're working in via a simple file-based hook
- **Auto-tab** - Intelligently switches views based on context (changes → history → PR diff)
- **Fuzzy file finder** - `Ctrl+P` to jump to any file in the repo
- **PR review** - Compare your branch against any base branch with per-file and per-commit diffs
- **Mouse & keyboard** - Click to stage, scroll through diffs, or use vim-style `j`/`k` navigation
- **Right-click to discard** - Quickly throw away unwanted changes with confirmation
- **Resizable panes** - `[` and `]` to adjust the split between file list and diff
- **Line wrapping** - Toggle with `w` for long lines
- **6 themes** - Dark, light, colorblind-friendly (blue/red palette), and ANSI-only variants that use your terminal's colors

## Architecture

The git engine runs in a background daemon, **diffstalkerd**, which serves
`@diffstalker/core` (headless git state) over REST + Server-Sent Events. The
terminal UI is a lean client: it installs `diffstalkerd` as a dependency and
auto-spawns it on a unix socket, opening repos over REST and following live
state over SSE. It holds no in-process git of its own. The UX is unchanged —
the split just means the same daemon can back other clients. A **web UI** (Vue 3)
is now built in: the daemon serves a read-only viewer at `GET /` over the same
REST + SSE (see below).

## Installation

```bash
npm install -g diffstalker
```

Installing `diffstalker` pulls in `diffstalkerd` automatically; the UI spawns
it for you on first run.

Or from source (the repo is a bun workspace of several packages):
```bash
git clone https://github.com/yogh-io/diffstalker.git
cd diffstalker
bun install && bun run build       # builds all packages
cd packages/cli && npm link        # link the `diffstalker` bin
# or run it directly: bun run start
```

## Quick Start

```bash
diffstalker              # current directory
diffstalker /path/to/repo
diffstalker --follow     # watch for repo changes (recommended for second monitor)
```

Follow mode watches `~/.cache/diffstalker/target` for repository paths. Write or append to this file - diffstalker reads the last non-empty line, so both styles work.

### Integration Examples

**Shell hook** - update on every `cd`:
```bash
# Add to .bashrc or .zshrc
diffstalker_notify() {
    [[ -d .git ]] && echo "$PWD" > ~/.cache/diffstalker/target
}
cd() { builtin cd "$@" && diffstalker_notify; }
```

**Tmux** - update on pane/window switch:
```bash
# In .tmux.conf
set-hook -g pane-focus-in 'run-shell "tmux display -p \"#{pane_current_path}\" > ~/.cache/diffstalker/target"'
```

**Neovim** - update when changing buffers:
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

**Any script:**
```bash
echo "/path/to/repo" > ~/.cache/diffstalker/target   # overwrite
echo "/path/to/repo" >> ~/.cache/diffstalker/target  # append (also works)
```

The file-based approach is intentionally simple. IDE plugins, window manager hooks, project switchers, git hooks - if it can write to a file, it can drive diffstalker.

## Views

| Key | View | What it does |
|-----|------|--------------|
| `1` | **Diff** | Stage/unstage files, review word-level diffs |
| `2` | **Commit** | Write commit messages, amend previous commits |
| `3` | **History** | Browse recent commits and inspect their diffs |
| `4` | **PR** | Compare branch against a base branch with per-file navigation |
| `5` | **Explorer** | Browse the file tree with syntax-highlighted preview and fuzzy finder |

## Keybindings

| Action | Keys |
|--------|------|
| Navigate | `↑`/`↓` or `j`/`k` |
| Switch panes | `Tab` |
| Switch views | `1`-`5` |
| Toggle stage | `Space` or `Enter` |
| Stage/unstage all | `Shift+A` / `Shift+Z` |
| Discard changes | `d` (with confirmation) |
| Fuzzy file finder | `Ctrl+P` or `/` in Explorer |
| Resize panes | `[` / `]` |
| Toggle line wrap | `w` |
| Themes | `t` |
| Help | `?` |

Full keybinding reference available with `?` in the app.

## Themes

Six built-in themes - press `t` to switch:

| Theme | Description |
|-------|-------------|
| Dark / Light | Default palettes |
| Dark / Light (colorblind) | Blue/red palette for color vision deficiency |
| Dark / Light (ANSI) | Uses your terminal's 16 colors for full consistency |

## Configuration

Config file: `~/.config/diffstalker/config.json`

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
  -s, --socket PATH    diffstalkerd socket to attach to or spawn on
  -d, --debug          Log path changes to stderr
  -h, --help           Show help
```

## Web UI

The daemon ships a browser UI (Vue 3), served at `GET /`. A browser can't reach a
unix socket and the daemon sends no CORS headers, so run the daemon on a TCP port
and open it same-origin:

```bash
diffstalkerd --port 4600
# then open http://localhost:4600
```

Open a repository by its absolute path (the switcher, top-left), or launch the
daemon in follow mode and the UI switches with your hook file. The web UI is a
**read-only viewer** — it runs no git mutations (no staging, committing,
discarding, or remote/branch operations; those live in the terminal UI):

- **Changes** — file list + working-tree diffs with word-level highlighting
  (view only).
- **History** — commit log + a multi-file commit diff.
- **Compare** — a GitHub-style PR view against a base branch: file tree +
  stacked per-file diffs, collapsible folders.
- **Explorer** — a file tree with git-status decoration + syntax-highlighted
  content.
- Follow and auto mode, fuzzy file finder (Ctrl+P), the six themes, and keyboard
  shortcuts (`?` for help).

See the Web UI section of [FEATURES.md](FEATURES.md) for the full list.

> Security: the daemon has no authentication yet. By default it binds an
> owner-only unix socket (directory `0700`, socket `0600`) and no TCP port at
> all; a port is only opened when you pass `--port` (bound to `127.0.0.1`
> unless you set `--host`). Keep any port on localhost — do not expose it to a
> network.

## License

MIT
