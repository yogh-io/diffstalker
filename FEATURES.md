# FEATURES.md

Exhaustive feature inventory for diffstalker. This document serves as a migration checklist for future framework changes.

---

## Architecture

Every feature below is preserved; only the plumbing moved. The git state engine now lives in a **daemon** (`diffstalkerd`) that serves `@diffstalker/core` over REST + Server-Sent Events. The terminal UI (`diffstalker`) is a **client** of that daemon — it spawns or attaches to the daemon on a unix socket, opens repos over REST, and follows live state over SSE, holding no in-process git. The same daemon also serves the read-only web viewer (see [Web UI](#web-ui-browser-client)). See CLAUDE.md and `packages/daemon/README.md` for the split.

---

## Table of Contents

1. [Views](#views)
2. [Keyboard Shortcuts](#keyboard-shortcuts)
3. [Mouse Interactions](#mouse-interactions)
4. [Scrolling Architecture](#scrolling-architecture)
5. [Themes](#themes)
6. [Focus Navigation](#focus-navigation)
7. [Edge Cases](#edge-cases)
8. [Configuration](#configuration)

---

## Views

### Tab 1: Diff View (Default)

**Top Pane: File List**
- Displays files grouped by status: Modified -> Untracked -> Staged
- Each section has a colored header (Modified: yellow, Untracked: gray, Staged: green)
- Sections separated by blank lines (spacers)
- File row format: `[>] [+/-] S path (+insertions -deletions)`
  - `>` = selection indicator (cyan when selected)
  - `[+]` = stage button (green)
  - `[-]` = unstage button (red)
  - `S` = status char (M/A/D/?/R/C)
  - Path is shortened if too long with middle ellipsis
  - Stats show insertions (green) and deletions (red)
- Renamed files show `<- original-path`
- Selection indicator highlights entire row with inverse+cyan
- First category header shows `(h:flat)` hint for toggling to flat view
- **Flat View Mode** (toggle with `h`): Shows all files in a single alphabetically sorted list
  - Header row: `All files (h):` — press `h` to toggle back to categorized
  - Each unique file path appears once, even if partially staged
  - Staging state shown via button: `[+]` green (unstaged), `[-]` red (staged), `[~]` yellow (partial)
  - Hunk indicator: `@2/4` = 2 staged out of 4 total hunks (always shows staged/total)
  - Stage/unstage: `s`/`Space`/`Enter` stage if unstaged, unstage if staged, complete staging if partial
  - **Unified diff**: Diff pane shows all hunks interleaved by file position in a single view
    - Every hunk has a gutter indicator: cyan `▎` = unstaged, green `▎` = staged
    - Selected hunk has a bold gutter; `n`/`N` auto-scrolls to keep hunk header visible
    - Hunks stay in file order when staged/unstaged — they don't disappear or reorder
    - `s`/`u` in diff pane stages/unstages the hunk under cursor

**Bottom Pane: Diff Display**
- Shows unified diff for selected file
- Line number column (left-aligned, width adapts to max line)
- Symbol column (+/-/space)
- Content column with word-level diff highlighting
- Line types:
  - Addition: green background, `+` symbol
  - Deletion: red background, `-` symbol
  - Context: no background, space symbol
  - Hunk header: `@@` prefix, dimmed
  - File header: `diff --git` prefix
- Word-level highlighting within add/del lines (darker highlight for changed words)
- Optional line wrapping (toggle with `w`)
- **Hunk edit times**: every hunk header shows when its content last changed ("just now", "42 seconds ago", "5 minutes ago", "2 days ago"). Times come from live observation while diffstalker runs (content-keyed, so a hunk keeps its time when line numbers shift); the file's mtime is the fallback for changes that predate the session. Sub-minute times tick every second.
- **Fresh-hunk flash and auto-scroll**: a hunk whose content just changed flashes yellow (like the file list's newest-change flash), and in auto mode the diff pane scrolls so the fresh change is always on screen.
- **Hunk Staging**: When diff pane is focused (via `Tab`), a cyan gutter indicator (`▎`) marks the selected hunk. Footer shows `hunk 1/3` position. Use `n`/`N` to navigate between hunks and `s`/`u` to stage/unstage individual hunks instead of entire files. Disabled for untracked files and binary files.

### Tab 2: Commit Panel

**Top Pane: File List** (same as Diff View)

**Bottom Pane: Commit Form**
- Header: "Commit Message" (with "(amending)" indicator when amend enabled)
- Text input field for commit message
  - Multi-line (4 rows) with border (cyan when focused, gray when unfocused)
  - `Enter` inserts a newline for body/trailer lines; `Ctrl+S` submits
  - Placeholder: "Press i or Enter to edit..."
- Amend checkbox: `[ ] Amend` (toggle with `a` when unfocused, `Ctrl+a` always)
  - When checked, loads previous commit message
- Click-to-focus: clicking anywhere in the commit panel focuses the input
- Help text shows staged count and context-sensitive hints
- Error/status display for commit operations

### Tab 3: History View

**Top Pane: Commit List**
- Each commit on one row: `hash message (date) refs`
  - Short hash (7 chars, yellow)
  - Message (truncated to fit, cyan when selected)
  - Relative date in parentheses, dimmed
  - Refs (branches/tags) in green
- ScrollableList with scroll indicators

**Bottom Pane: Commit Diff**
- Commit metadata header:
  - `commit <full-hash>`
  - `Author: <name>`
  - `Date: <absolute-date>`
- Blank line
- Commit message (indented with 4 spaces)
- Blank line
- Full diff content (same rendering as Diff View)
- **History actions**:
  - `p`: cherry-pick the selected commit (with confirmation dialog)
  - `v`: revert the selected commit (with confirmation dialog)

### Tab 4: Compare View (PR View)

**Top Pane: Compare List**
- Two collapsible sections (currently always expanded):
  - `V Commits (N)` header
  - Commit rows (same format as History)
  - Spacer
  - `V Files (N)` header
  - File rows showing: status char, path, (+additions -deletions)
- Uncommitted files marked with `*` prefix and `[uncommitted]` suffix (magenta)
- Base branch shown in header
- Toggle uncommitted with `u`
- Change base branch with `b`

**Bottom Pane: Compare Diff**
- When commit selected: shows that commit's diff
- When file selected: scrolls to that file in combined diff
- Combined diff of all files in the comparison

### Tab 5: Explorer View

**Top Pane: File Tree**
- Collapsible tree view with directory hierarchy
- Tree lines (├ └ │) for visual hierarchy
- Directories with expand/collapse icons (▸ collapsed, ▾ expanded)
- Single-child directory chains collapsed (e.g., `src/main/java/` shown as one node)
- Git status indicators on files:
  - `M` Modified (yellow)
  - `A` Added (green)
  - `D` Deleted (red)
  - `?` Untracked (gray)
  - `R` Renamed (blue)
- Directory status indicator: `●` (yellow) if contains changed files
- Filter to show only changed files (toggle with `g`)

**Bottom Pane: File Content**
- Syntax-highlighted file preview
- Line numbers (gray)
- Binary files, and files over the per-file diff cap, show a one-line
  notice instead of a body (see Edge Cases → Large Files)
- Large files truncated with "File truncated..." message

**File Finder Modal**
- Open with `/` key
- Fuzzy search across all files in repo using the fzf algorithm (fzf-for-js)
- Real-time filtering as you type
- Smart-case matching: case-insensitive unless query contains uppercase
- PascalCase/camelCase aware: uppercase letters in query preferentially match word boundaries (e.g., "HLV" matches "HabitatListView")
- Navigate results with Ctrl+j/k or Up/Down arrows
- Select with Enter, cancel with Escape
- Matched characters highlighted in yellow

---

## Keyboard Shortcuts

### Navigation

| Key | Action | Context |
|-----|--------|---------|
| `Up` / `k` | Move up | All views |
| `Down` / `j` | Move down | All views |
| `PageDown` / `Ctrl+D` | Page down (list selection or diff scroll) | All views |
| `PageUp` / `Ctrl+U` | Page up (list selection or diff scroll) | All views |
| `g` | Jump to top | All views except Explorer (filter toggle there) |
| `G` (Shift+G) | Jump to bottom | All views except Explorer |
| `Tab` | Cycle to next focus zone | All views |
| `Shift+Tab` | Cycle to previous focus zone | All views |
| `1` | Switch to Diff tab | All views |
| `2` | Switch to Commit tab | All views |
| `3` | Switch to History tab | All views |
| `4` | Switch to Compare tab | All views |
| `5` | Switch to Explorer tab | All views |

### Staging Operations

| Key | Action |
|-----|--------|
| `s` | Stage selected file (or current hunk when diff pane focused) |
| `Shift+U` | Unstage selected file (or current hunk when diff pane focused) |
| `Shift+A` | Stage all files |
| `Shift+Z` | Unstage all files |
| `Space` / `Enter` | Toggle stage/unstage for selected file |

### Hunk Staging (Diff Pane Focused)

| Key | Action |
|-----|--------|
| `n` | Jump to next hunk |
| `N` (Shift+N) | Jump to previous hunk |
| `s` | Stage current hunk (unstaged files only) |
| `u` | Unstage current hunk (staged files only) |

### Actions

| Key | Action |
|-----|--------|
| `c` | Open commit panel (switch to Tab 2) |
| `d` | Discard changes, or delete an untracked file (unstaged files, with confirmation) |
| `r` | Open repo picker |
| `W` (Shift+W) | Open worktree switcher (worktrees of the current repo) |
| `q` / `Ctrl+C` | Quit application |

### History Actions (History Tab)

| Key | Action |
|-----|--------|
| `p` | Cherry-pick selected commit (confirmation required) |
| `v` | Revert selected commit (confirmation required) |

### Pane Resize

| Key | Action |
|-----|--------|
| `[` | Shrink top pane by 5% |
| `]` | Grow top pane by 5% |

### Compare View Specific

| Key | Action |
|-----|--------|
| `u` | Toggle include uncommitted changes |
| `b` | Open base branch picker modal |

### Explorer View Specific

| Key | Action |
|-----|--------|
| `Enter` | Expand/collapse directory |
| `Backspace` | Go up to parent directory (and collapse the one left) |
| `/` | Open file finder modal |
| `Ctrl+P` | Open file finder modal (works from any tab) |
| `g` | Toggle show only changed files |

### File Finder Modal

| Key | Action |
|-----|--------|
| `Enter` | Select highlighted file |
| `Escape` | Cancel and close modal |
| `Ctrl+j` / `Down` | Navigate to next result |
| `Ctrl+k` / `Up` | Navigate to previous result |
| `Tab` | Cycle through results |
| `Ctrl+C` | Quit diffstalker (bound here too: the finder's input takes over the keyboard) |

### Display Options

| Key | Action |
|-----|--------|
| `h` | Toggle flat file view (diff/commit tab) |
| `m` | Toggle mouse mode (scroll vs select) |
| `f` | Toggle follow mode (watch target file) |
| `a` | Toggle auto-tab mode |
| `w` | Toggle line wrap mode |
| `t` | Open theme picker modal |
| `?` | Open hotkeys help modal |

### Commit Panel Input

| Key | Action |
|-----|--------|
| `i` / `Enter` | Edit commit message (focus input) |
| `Ctrl+S` | Submit commit (when input focused) |
| `Enter` | Insert newline (when input focused; message body/trailers) |
| `Esc` | Unfocus input / return to Diff view |
| `a` | Toggle amend mode (when input not focused) |
| `Ctrl+a` | Toggle amend mode (works while typing) |

---

## Mouse Interactions

### Click Targets

| Target | Action |
|--------|--------|
| File row | Select file |
| Explorer folder (already selected) | Toggle expand/collapse |
| `[+]`/`[-]` button area | Stage/unstage file |
| Tab buttons (footer) | Switch to that tab |
| `?` indicator | Open hotkeys modal |
| Commit panel area | Focus commit input |
| `m:select`/`m:scroll` | Toggle mouse mode |
| `auto-tab` | Toggle auto-tab mode |
| `wrap` | Toggle wrap mode |

### Right-Click

| Target | Action |
|--------|--------|
| Modified file (not staged) | Open discard confirmation |

### Scroll Behavior

| Pane | Scroll Action |
|------|---------------|
| Top pane (file list) | Scroll file list |
| Top pane (history) | Scroll commit list |
| Top pane (compare) | Scroll compare list |
| Top pane (explorer) | Scroll directory listing |
| Bottom pane (diff) | Scroll diff content |
| Bottom pane (explorer) | Scroll file content |

### Mouse Mode Toggle

- `m:select` mode: clicks select items
- `m:scroll` mode: scrolling works in focused pane

---

## Scrolling Architecture

### Core Concepts

**Item-based vs Row-based Counting:**
- Some lists count items (files, commits)
- Others count display rows (diff lines with headers)
- Scroll offset is always row-based (terminal rows skipped)

**Available Height Calculation:**
- `maxHeight - 2` when scroll indicators present
- `maxHeight` when content fits without scrolling
- ScrollableList auto-detects need for scroll indicators

### Per-Pane Scrolling Details

| Pane | Count Type | Scroll Variable | Max Calculation |
|------|------------|-----------------|-----------------|
| File List (top) | Rows (includes section headers) | `fileListScrollOffset` | `getFileListTotalRows()` |
| Diff View (bottom) | Rows (DisplayRow[].length) | `diffScrollOffset` | `buildDiffDisplayRows().length` or wrapped count |
| History List (top) | Items (commits) | `historyScrollOffset` | `commits.length` |
| History Diff (bottom) | Rows | `diffScrollOffset` | `buildHistoryDisplayRows().length` |
| Compare List (top) | Rows (commits + files + headers) | `compareScrollOffset` | `getCompareListTotalRows()` |
| Compare Diff (bottom) | Rows | `diffScrollOffset` | `buildCompareDisplayRows().length` |
| Explorer List (top) | Items (files/dirs) | `explorerScrollOffset` | `items.length` |
| Explorer Content (bottom) | Rows | `explorerFileScrollOffset` | `getExplorerContentTotalRows()` |

### Key Functions

**Layout Calculations (FileList.ts):**
- `getFileListTotalRows(files)` - total rows including headers/spacers
- `getRowFromFileIndex(fileIndex, files)` - file index to display row
- `getFileIndexFromRow(row, files)` - display row to file index

**Row Building (Single Source of Truth Pattern):**
- `buildDiffDisplayRows(diff)` - unified DisplayRow[] for diff
- `buildCombinedDiffDisplayRows(unstaged, staged)` - combined unstaged+staged rows with section headers and hunk mapping
- `buildHistoryDisplayRows(commit, diff)` - commit + diff rows
- `buildCompareDisplayRows(compareDiff)` - combined file diffs
- `buildCompareListRows()` - commits + files + headers (in CompareListView)

**Row Mapping:**
- `getCommitIndexFromRow(row, commits, width, offset)` - history click -> commit
- `getCompareItemIndexFromRow(row, commitCount, fileCount)` - compare click -> item
- `getCompareRowFromItemIndex(index, commitCount, fileCount)` - item -> row for scrolling
- `getFileScrollOffset(compareDiff, fileIndex)` - file -> diff scroll position

### Wrap Mode

When wrap mode is enabled (`w` toggle):
- Long content lines break into continuation rows
- `wrapDisplayRows(rows, contentWidth, enabled)` - expands rows
- `getWrappedRowCount(rows, contentWidth, enabled)` - efficient count
- Continuation rows have `isContinuation: true`, no line number
- Only diff content lines wrap; headers/metadata truncate

### Common Pitfalls

1. **Item vs Row Confusion**: Using item count when row count needed (or vice versa). File list has section headers that add rows.

2. **Forgetting Section Headers**: Section headers ("Modified:", "Commits:") and spacers add extra rows to total count.

3. **Scroll Indicator Space**: When content needs scrolling, 2 rows are consumed by "^ above" and "v below" indicators.

4. **Wrap Mode Multiplier**: When wrap mode enabled, row counts multiply significantly for long lines.

5. **Inconsistent Row Counting**: Always use the same function for both rendering and scroll calculations.

### Single Source of Truth Pattern

Critical for avoiding scroll/render mismatches:

```typescript
// CORRECT: One function builds rows for both purposes
const rows = buildCompareListRows(commits, files);
// Rendering uses: rows.map(...)
// Scroll max uses: rows.length

// WRONG: Separate counting logic
const renderRows = [...]; // Built one way
const scrollMax = commits.length + files.length; // Counted differently
```

---

## Themes

### Available Themes

| Theme Name | Description |
|------------|-------------|
| `dark` | Default dark theme (sampled from Claude Code) |
| `light` | Light theme |
| `dark-colorblind` | Dark daltonized (blue for additions) |
| `light-colorblind` | Light daltonized |
| `dark-ansi` | Dark using terminal's 16 ANSI colors |
| `light-ansi` | Light using terminal's 16 ANSI colors |

### Theme Color Properties

Each theme defines `DiffColors`:
- `addBg` - Background for addition lines
- `delBg` - Background for deletion lines
- `addHighlight` - Word-level highlight for added text
- `delHighlight` - Word-level highlight for deleted text
- `text` - Default text color
- `addLineNum` - Line number color for additions
- `delLineNum` - Line number color for deletions
- `contextLineNum` - Line number color for context lines
- `addSymbol` - Color for `+` symbol
- `delSymbol` - Color for `-` symbol

### Theme Persistence

Selected theme is saved to `~/.config/diffstalker/config.json`.

---

## Focus Navigation

The app uses a **focus zone** system for full keyboard-only navigation with `Tab`/`Shift+Tab`.

### Focus Zones Per Tab

| Tab | Zones (Tab order) | Default |
|-----|--------------------|---------|
| Diff | `fileList` → `diffView` | `fileList` |
| Commit | `fileList` → `commitMessage` → `commitAmend` | `commitMessage` |
| History | `historyList` → `historyDiff` | `historyList` |
| Compare | `compareList` → `compareDiff` | `compareList` |
| Explorer | `explorerTree` → `explorerContent` | `explorerTree` |

### Visual Indicators

- **Middle separator**: Cyan when a top-pane zone is focused, gray for bottom-pane zones
- **Commit message input**: Cyan border when `commitMessage` zone is focused (even before editing)
- **Amend checkbox**: `▸` marker in cyan when `commitAmend` zone is focused
- **Help text**: Context-sensitive hints based on focused zone

### Space/Enter Activation

| Zone | Action |
|------|--------|
| `fileList` | Toggle stage/unstage |
| `commitMessage` | Enter editing mode |
| `commitAmend` | Toggle amend checkbox |
| `explorerTree` | Enter directory |

---

## Edge Cases

### Empty States

| Condition | Display |
|-----------|---------|
| No changes | "No changes" in file list |
| No commits | "No commits yet" in history |
| No comparison | "No changes compared to base branch" |
| Empty directory | "(empty directory)" in explorer |

### Binary Files

- Diff view shows "Binary file — no text diff to show." in place of a body
- Explorer shows "Binary file" message instead of content
- The web UI is the exception for PNG, JPEG and GIF: it renders them (see
  [Web UI](#web-ui-browser-client)). Every other binary keeps the note, with
  the refusal reason appended. The terminal UI cannot draw pixels and keeps
  the note for everything.
- An untracked binary is detected by its bytes (a NUL in the first 8 KB), not
  by its name, so a newly added PNG gets git's own
  `Binary files /dev/null and b/logo.png differ` marker rather than a wall of
  decoded mojibake

### Large Files

- **Per-file diff cap (all diff surfaces).** A file whose diff exceeds
  `MAX_FILE_DIFF_BYTES` (256 KB) or `MAX_FILE_DIFF_LINES` (5,000) is not
  sent at all. The file keeps its header, status letter, and +/− stats;
  its body is the single line `Large file — diff not shown (5.7 MB,
  121,235 lines)`. Applied in `core/git/diffParse` where diffs are built,
  so it covers every path — working tree, compare, commit diffs, journal,
  untracked files — and both the web UI and the CLI. Binary files and
  over-cap files render through the *same* placeholder: the two reasons a
  diff is deliberately withheld, always stated rather than shown as an
  empty diff. The byte cap is what catches long-line files (minified
  bundles, single-line exported SVGs) that the line cap misses.
- An untracked file over the byte cap is never read; it gets the same
  notice (byte size only — its line count is unknown).
- Explorer truncates file content at ~1MB
- Shows "File truncated at 1MB for performance..." message

### Unicode Filenames

- Properly displayed and handled
- Path shortening preserves Unicode characters

### Long Paths

- Paths shortened with middle ellipsis: `src/.../Component.tsx`
- `shortenPath(path, maxLength)` utility handles this

### Renamed Files

- Status `R` with path and `<- original-path`
- Both paths shown in file list

### Merge Conflicts

- An unmerged path carries its own status, `conflicted`, shown as `U` in the
  file lists and the Explorer (bright red in the terminal, its own theme
  colour in the browser)
- The browser refuses to stage or unstage it and says why: `git add` would
  claim a resolution that has not happened, unstaging would drop the conflict
  stages. Resolve it in your editor, then stage
- `shared.operationInProgress` (merge / rebase / cherry-pick / revert) says
  the repo is stopped; the per-file status says which paths are blocking it

### Files With No Trailing Newline

- Git's `\ No newline at end of file` is shown as a dim annotation of the line
  above it, with no line number and no `+`/`-` marker — it is not a line of
  either file
- Side by side, it appears only on the side it is about, and it does not break
  the pairing (or the word-level highlighting) of the changed last line

### No Repository

- Error shown in header if not in a git repo
- Operations fail gracefully
- A repository path must be absolute (a leading `~` is expanded); the daemon
  cannot resolve a relative path, because its working directory is not yours

### Git Worktrees

- Any opened or followed path is normalized to its containing worktree root, so
  launching from (or following a file inside) a subdirectory or a linked
  worktree resolves to the correct working tree automatically
- Opening or following a bare-repo container (the parent of a `.bare/` +
  worktrees layout) automatically opens its most recently active worktree
  (by git index/HEAD activity) instead of prompting for a choice
- `W` (Shift+W) switches between the worktrees of the current repository

### Large Diffs

- Scrollable with consistent performance
- Row-based rendering (only visible rows rendered)

---

## Configuration

### Config File Location

`~/.config/diffstalker/config.json`

### Configurable Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `theme` | string | `"dark"` | Color theme name |
| `splitRatio` | number | `0.4` | Top/bottom pane split (0.15-0.85) |
| `watcherEnabled` | boolean | `false` | Follow mode enabled |
| `targetFile` | string | `"~/.cache/diffstalker/target"` | File path to watch |
| `debug` | boolean | `false` | Debug logging enabled |

### CLI Arguments

| Argument | Description |
|----------|-------------|
| `[path]` | Fixed repository path (one only; a second path is an error) |
| `-f, --follow [FILE]` | Enable follow mode, optionally with custom file |
| `-s, --socket PATH` | diffstalkerd socket to attach to or spawn on |
| `--instance NAME` | Attach to (or spawn) the daemon named NAME |
| `-d, --debug` | Enable debug logging |
| `-h, --help` | Show help message |
| `-v, --version` | Print the version, plus which cli/daemon binaries this install runs |

An unrecognized option (anything else starting with `-`) exits 2 with
`unknown option`; it is never taken for a repository path.

---

## Terminal Requirements

- **Minimum size**: Layout requires minimum height for both panes
- **Mouse support**: SGR extended mode (1006) for accurate coordinates
- **True color**: Hex colors used in non-ANSI themes
- **Unicode**: Box-drawing characters and symbols used

---

## Layout Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `LAYOUT_OVERHEAD` | 5 | Lines used by header, separators, footer |
| `SPLIT_RATIO_STEP` | 0.05 | Pane resize increment |
| Min split ratio | 0.15 | Minimum top pane size |
| Max split ratio | 0.85 | Maximum top pane size |

### Default Split Ratios by Tab

| Tab | Default Ratio |
|-----|---------------|
| Diff | 0.4 (40% top) |
| Commit | 0.4 |
| History | 0.5 |
| Compare | 0.5 |
| Explorer | 0.4 |

---

## Modals

### Theme Picker Modal

- Grid of theme options
- Current theme highlighted
- Navigate with arrows, select with Enter
- Close with Esc

### Hotkeys Modal

- Comprehensive keyboard shortcut reference
- Two-column layout on wide terminals
- Close with Esc, Enter, `?`, or any mouse click

### Base Branch Picker Modal

- List of candidate base branches
- Current branch highlighted
- Text input for filtering (if many branches)
- Close with Esc

### Discard Confirmation

- Inline prompt: "Discard changes to <file>? (y/n)"
- `y` confirms, `n` or Esc cancels

### Commit Action Confirmation (Cherry-pick / Revert)

- Shows verb ("Cherry-pick" or "Revert") and commit info
- `y` confirms, `n` or Esc cancels

### File Finder Modal

- Fuzzy file search across entire repository using the fzf algorithm
- Text input for search query
- Smart-case: case-insensitive unless query contains uppercase
- PascalCase/camelCase aware: typing uppercase letters anchors matches to word boundaries (e.g., "HLView" → "HabitatListView")
- Top 15 results shown with match highlighting
- Navigate with Ctrl+j/k, Up/Down, or Tab
- Select with Enter, cancel with Escape
- Automatically expands tree to show selected file

### Repo Picker Modal

- Open with `r` key
- Lists recently-visited repositories (persisted across sessions)
- Current repo marked with `(current)`
- Navigate with j/k, select with Enter, cancel with Esc/q/r
- Selecting a different repo switches to it (stops follow mode if active)
- Recent repos stored in `~/.config/diffstalker/config.json` (max configurable via `maxRecentRepos`, default 10)

---

## Auto-Tab Mode

When enabled (`a` toggle):
- Files appearing: auto-switch to Diff view
- Files disappearing (commit): auto-switch to History view
- Shows newest commit after commit
- Auto-scroll to latest change: whenever a file's content changes on disk (an
  edit lands or a new file appears), the newest-changed file is auto-selected,
  the diff resets to its first hunk, and the file briefly flashes. Detection is
  by file mtime, so staging or moving the selection never triggers a jump —
  only real content changes do.

---

## Web UI (browser client)

`@diffstalker/web` is a Vue 3 single-page app served by the daemon at `GET /`
(run `diffstalkerd --port N`, open `http://localhost:N` — same-origin, since the
daemon has no CORS and a browser can't reach the unix socket). It is a pure daemon
client over the same REST + SSE, laid out for a real screen (persistent panes
instead of tab-switching).

`--port` **adds** the browser's transport rather than replacing the unix socket,
so one daemon serves the terminal UI and the browser over a single git state and
event stream — the TUI attaches to it instead of spawning its own. Each listener
gets its own API surface, graded by how well the transport is protected: the
owner-only (`0600`) socket carries the full API, the port carries the web subset
below. On Arch, `systemctl --user enable --now diffstalkerd` starts exactly that
daemon (see the daemon README for the unit). The web UI is **nearly a viewer**: the only git
mutation it makes is file-level **stage / unstage** (from the Changes list);
there is no commit, discard, hunk-staging, or remote/branch operation (those
live in the terminal UI). Its other non-GET calls are opening a repo
(`POST /repos`) and releasing it (`DELETE /repos/:id`) — attach/refcount, not
git operations.

### Views

- **Changes** — the working-tree viewer: a grouped file list (Modified /
  Untracked / Staged) with status letters, +/− stats, and hunk-count
  indicators, beside the selected file's diff. Word-level highlighting,
  per-hunk edit times, line-number gutters. Each row has a stage (+) /
  unstage (−) button at its start (the file moves between the Modified/
  Untracked and Staged sections live); no commit, discard, or hunk-staging.
- **Journal** — a chronological, downward-only log of every change as it
  happens, tracked **per hunk** (not per file): two edits to two different
  files land as two entries at the bottom even if those files also changed
  higher up. Each entry carries a timestamp, path, a kind
  (created / edited / expanded / shrunk / reverted / renamed), a line span,
  +/− stats, and its own diff. When a hunk is edited/expanded/shrunk/reverted
  the **older entry higher up is marked outdated and collapses** while the new
  one appears at the bottom (lineage via a `supersedes` chain). Rapid edits to
  the same hunk fold into one entry (a short client-side fold window). The log
  is daemon-owned (HEAD-axis observation, in-memory), streamed over SSE with an
  epoch/`since` reconnect protocol, and pruned to a bounded size. Huge / binary
  files show a collapsed placeholder (open explicitly to render). Read-only.
  On a long path the file name stays visible (the directory ellipses instead,
  and the full path is on hover); a per-entry copy button copies the full path.
  The kind badge and the "changed before the Journal started" (seeded) note
  explain themselves on hover.
- **History** — commit list (hash, message, author, relative date, ref chips)
  beside a commit detail: metadata + a multi-file diff with per-file section
  headers.
- **Compare** — a GitHub-PR-style view against a base branch: base selector
  (a client-side pick read via `GET /compare?base=…` — never persisted
  daemon-side), include-uncommitted toggle, stats, a collapsible commits list,
  a file tree, and stacked per-file diffs with sticky collapse headers.
  Tree folders collapse per-directory (chevron button or row click,
  Enter/Space/Left/Right on the button) — view state only; keyboard file
  navigation skips files hidden under a collapsed folder, and the stacked
  diffs on the right are unaffected.
- File cards in the stacked diffs (every surface built on the stack —
  Changes, Compare, History, Journal): each file is one bordered, rounded
  card with a tinted body, a 3px left spine, and a header ranked one surface
  above the hunk headers, so a file reads as a single object instead of a
  continuous strip. The spine is the only chrome spanning the file's whole
  height, which is what answers "which file am I in" mid-scroll; the active
  file's card takes the selection color, and an uncommitted file's spine
  takes the uncommitted color. Costs +1px per file and gives back 1px per
  hunk (the hunk seams were doubled hairlines), so a multi-hunk file is net
  shorter than before.
- "view file" button in every diff header (Changes, Journal, History,
  Compare): jumps from a file's diff to the file itself in the Explorer —
  the tree expands down to it and its content opens, the same reveal the
  fuzzy finder and follow mode use.
- Consistent panel separation across every split view: the index panel and the
  payload beside it are separated by page background, not a rule. Each payload
  is a card (a diff stack's files, Explorer's file contents, History's commit
  diff), so all four tabs read the same way. The gutter between file cards
  steps with the layout: wide on a desktop, collapsing to the inline gutter
  when the panes stack, which gives back about one diff row per file boundary
  on a phone.
- **Explorer** — a VS Code-style lazy file tree with git-status decoration
  (dotfile / ignored / changed-only toggles) beside syntax-highlighted file
  content (highlight.js) with binary / truncated / too-large states.
  Single-child directory chains collapse onto one combined row
  (`packages/cli/src`) on expand, like the CLI's explorer.
- **Image preview in the Explorer** — a PNG, JPEG or GIF opens as a picture on
  a checkerboard stage instead of the "Binary file" note, with the format,
  pixel size and (for an animated GIF) frame count in the pane header. One
  `1:1` toggle switches between shrink-to-fit (never upscaling, so a 16×16
  favicon stays 16×16) and actual size, where the stage scrolls. The
  preference survives switching from image to image. There is no zoom, no pan
  gesture, and deliberately no "open raw" / "download" link: a link that
  navigates the browser to repository bytes is exactly the threat the design
  exists to prevent. Anything that is not one of the three formats keeps the
  plain note plus the reason (`no preview (format not rendered)`,
  `no preview (over the preview pixel budget: 8192 px per side, 16 MP per
  image, 256 frames, or 33 MP across an animation)`, and so on). A refusal
  names every cap that can produce it, because the reason code carries no
  number: telling someone refused for frame count about a pixel cap that was
  never applied to their file is worse than saying nothing.
- **Image diffs in Changes** — a changed PNG/JPEG/GIF renders as a fixed-height
  card with both versions instead of "Binary file — no text diff to show".
  Three modes, chosen once for the whole app and remembered: **Side by side**
  (the only mode that is honest when the two versions differ in size),
  **Swipe** (one slider wipes the new version over the old) and **Onion**
  (the slider cross-fades them). All three are pure CSS — no canvas, no
  server-side decoding. The meta line always states both byte sizes, both
  short object ids and the byte delta, and says "metadata only" when the
  pixel dimensions match but the bytes do not: two identical-looking images
  can differ in EXIF (GPS, camera serial, an embedded thumbnail) or ICC, and
  a reviewer must never conclude "nothing changed" from the picture alone.
  Added and deleted files show one version plus a dim plate for the missing
  side; the card keeps the same height either way, so the stack's scroll
  position never jumps. Only Changes has this — Compare, History and Journal
  keep the plain note (their old side is a commit, which the viewer's
  worktree/index/head vocabulary cannot name yet).

### Header & global

- Branch indicator: current branch → tracking, ahead/behind counts —
  read-only text, no fetch/pull/push controls.
- Tab counts on the activity rail: **Changes** shows the changed-file count,
  **Compare** the number of commits against the base branch, so a tab says
  whether it is worth opening. Both show `(0)` rather than hiding — an empty
  tab IS the signal — and both survive the cramped icon-only band, where the
  count is all that is left. Changes reads the streamed status; Compare has
  no stream, so it rides a dedicated `GET /compare/count`
  (`git rev-list --count`) pulled on every applied state — the full compare
  payload is far too heavy to fetch for a number. Once the Compare view is
  open its loaded commit list becomes the authority, so the badge can never
  contradict the list it labels. No base branch to compare against shows no
  badge at all, never a misleading `(0)`.
- **The URL names one place.** `/<view>/<repo-segments>?at=…&base=…` — the
  view leads, so parsing is positional and a repo directory called
  `history` is just a directory. `~` as the first repo segment means
  $HOME-relative (a directory literally named `~` writes as `%7E`); a repo
  outside home keeps its absolute path. `at` is the one thing the view is
  aimed at: Changes' file with its staged/unstaged side
  (`?at=u:packages/web/src/App.vue`), History's commit (`?at=4d1c44a`),
  Compare's file, the Explorer's open file. Compare also carries `base`
  when one was explicitly picked. Journal carries none — its entry seqs
  restart on a daemon restart, so a remembered one would point at an
  unrelated entry. Preferences (theme, wrap, syntax, split, filters),
  expansion sets and scroll offsets are not places and never appear.
  Any such link reloads into exactly that state (the daemon serves the SPA
  for any non-API path): the repo opens, the view paints, the tree expands
  down to the file, the commit's diff loads — including a commit older than
  the loaded log, which resolves through `GET /repos/:id/commits/:hash`.
  What the URL cannot name any more just drops (a file that was committed,
  a commit rebased away), which is ordinary churn, not an error.
- **A history entry means you did something.** Back walks back through what
  you chose, not through what happened to you. A gesture — a tab, a repo or
  worktree switch, "view file", the finder, activating a row in any list, a
  compare base pick — is exactly one entry, however many writes it takes
  behind the scenes. Arrow movement inside a list is not (holding Down
  would bury the real navigation), and neither is follow mode tracking your
  editor, auto mode jumping to a fresh commit, the scroll-spy, or staging a
  file. The one exception: the FIRST time an ambient actor drags you off a
  place you picked by hand, that yank is undoable once. Back into an
  Explorer, Changes, Compare or History entry re-opens its file or commit
  and scrolls straight to it; back out of one closes it again. A Back also
  holds follow mode off for 1500ms, so an editor save landing right after
  cannot silently undo it.
- Repo switcher (open by absolute path, recent repos, **discovered projects**),
  follow-mode toggle, theme switcher (the same six themes as CSS variables),
  fuzzy file finder (Ctrl+P), a settings panel (`,`), and a hotkeys overlay
  (`?`). Live over SSE, with a calm reconnect banner.
- **Keyboard shortcut sheet** (`?`) — nine small groups cut by what you are
  trying to do (open something, switch view, change the display, move in a
  list), none over five rows, flowed into as many columns as the window
  affords: four on a laptop with the whole sheet visible at once, one on a
  phone in priority order. It is CSS columns rather than a grid because a grid
  row is as tall as its tallest cell, and one long group beside a short one is
  what made the old sheet a half-empty box you had to scroll. It also documents
  what it always left out: `j`/`k` in the stacked layout, arrow keys resizing a
  divider, Enter or Space folding a commit in the Journal, typing to narrow the
  outline — and Enter and Space are now separate rows in lists, because Enter
  hands focus to the diff and Space keeps it in the list.
- **Settings panel** (gear in the header, or `,`) — two kinds of setting, and
  it says which is which: **Appearance** is this browser's (theme, in
  localStorage), **Repositories** is the daemon's (one file on its machine,
  shared by every client, surviving a restart). A daemon holding settings in
  memory only says so instead of implying a save. The theme picker lives here
  and only here — it is a set-once choice, so a select parked in the chrome
  cost more room than it earned.
- **Watch directories** — point diffstalker at the folder you keep projects in
  and every git repo in it shows up in the repo switcher, ready to open; a
  browser cannot browse the daemon's filesystem, so this is what replaces
  typing an absolute path every time. Discovery LISTS repos, it never opens
  them (opening is what costs a watcher and git state per repo). The scan is
  filesystem-only — no git process — reading the branch from `.git/HEAD` and
  the last activity from the git dir's `index`/`HEAD` mtimes: children of the
  root plus one level further inside a child that is not itself a repo, never
  descending into a repo (so no submodule is listed as a project), skipping
  dot-dirs and `node_modules`, capped at 500 with `capped` reported rather
  than a silently short list. Each root is watched one level deep, so a fresh
  clone appears without a reload. **Browse…** picks a directory by walking the
  daemon's own filesystem (`GET /browse`, directory names only), because a
  browser is never handed a real path by its file pickers — `webkitdirectory`
  yields relative names and `showDirectoryPicker` a bare handle, so a purely
  client-side picker could not name anything the daemon could open. Directories
  that are themselves repos are marked, since the folder you want is usually
  their parent. Rows are ordered **most recently touched
  first** with the age beside the path — projects untouched for half a year
  sink to the bottom and their names drop to the dim weight, because a
  projects folder is mostly archaeology and the three you are working on this
  week are the answer nearly every time. Over eight projects, the list grows a
  filter field. A root that has gone missing (an unmounted disk) keeps its
  place in the settings and reports the reason; it is never quietly dropped.
- **In-file outline** (bare `o`, Explorer) — the symbols in the open file, from
  a real parser (tree-sitter compiled to WebAssembly), not a regex. Filter by
  name, Enter jumps to the line. Vue has no grammar of its own, so its `<script>` blocks are fed to the TypeScript parser as ranges,
  which keeps line numbers file-absolute across BOTH blocks when a component has
  two. An unsupported language says so by extension — there is no regex second
  pass, because a confidently wrong symbol is worse than an absent one.
  TypeScript, Vue, JavaScript and Java today; a language is a vendored grammar
  plus a query file, so adding one is data rather than code. This is
  syntax, never semantics: nothing resolves, so methods attached via
  `Object.assign(X.prototype, …)`, re-exports and decorator-synthesized members
  are invisible by design.
- **The parser is opt-in and ships separately** (`diffstalkerd-grammars`). A
  default `diffstalkerd` install does not carry it, and outlines are simply
  absent — `/health` reports which extensions this install can outline, and an
  empty list is a normal state, not a degraded one. The grammars run in a worker
  thread the daemon discards and respawns on any timeout or crash: a cancelled
  tree-sitter parse poisons its parser so the NEXT file would get the previous
  file's symbols, and throwing the thread away is the only reliable cure.
- **Repo-wide content search** (Ctrl/⌘+Shift+F, or bare `F`) — the one surface
  that reads bytes the client does not already hold, so every bound is
  server-side: `git grep -F` (literal text, never a regex), 500 results, 20 per
  file, 4 MiB, 5 seconds, 400 characters per line. Corpus is tracked plus
  untracked and never gitignored — the same set the file finder offers. Hits
  group by file; Enter reveals the file in the Explorer and scrolls to the line.
  The endpoint is **POST**, not GET, because GET is exempt from the daemon's
  CSRF guard and a repo id is derivable from a guessed path — a GET search would
  be a cross-site timing oracle against a local daemon. Matched text is rendered
  as text, never markup.
- **One visible door to all three** — the search overlays carry a mode strip
  naming every search gesture and the key it answers to: `Files Ctrl P`,
  `Contents ⇧F`, `Outline o`. Only the finder ever had a visible way in (the
  header button, now labelled **Search**), so the other two were reachable only
  by already knowing them; printing all three on the surface you do open means
  the keys get learned by using the app instead of by remembering to open the
  help sheet first. Every mode is clickable, so no key is load-bearing. It is
  **not** a palette: no prefix, no mode token in the query, nothing parses
  input — each mode keeps its own corpus, debounce and cost, and the strip only
  switches which is open. The query follows you across a switch, so changing
  your mind mid-word costs nothing. Outline stays a popover beside the code
  rather than becoming a mode inside the modal, so it never scrims the file it
  describes; choosing it closes the overlay, switches to Explorer and opens the
  popover there (the request waits a tick for the Explorer to exist — firing it
  first loses it silently).
- **`/` narrows the changed-file list** — a filter, not a search. It hides rows
  from the set already on screen: no syntax, no scopes, no request. The diff
  stack derives from the same ordered list, so narrowing the list also shortens
  the page, which makes it the row-budget lever on a big changeset. The count
  names its corpus ("4 of 214 changed files"); a filter matching nothing renders
  its own note, never the clean-tree state, because the clean check reads the
  raw status. Session-only, never persisted, never in the URL (a query is a
  filter over a set, not a place), and reset whenever the repo changes — follow
  mode switching repos under you is the common case. `/` again returns the
  caret; Esc clears.
- **Search is the browser's, and the app keeps it working.** Ctrl+F (find in
  page) is the in-diff search — that is why windowed virtualization was
  rejected: it would forfeit find-in-page and text selection. The one thing
  the DOM withholds is a file past 1500 changed lines, which starts behind a
  "Load diff" gate. `e` mounts every gated body at once, after which Ctrl+F
  reaches the whole changeset. Ctrl+H and Ctrl+O are deliberately not bound:
  they are browser History and the file picker, and ⌘+H is macOS "hide
  application", which a page cannot intercept at all.
  Both the open-on-daemon list and the recent-repos list group a repo's
  worktrees under one project row (e.g. "calculator" instead of one row per
  worktree); picking a recent multi-worktree project opens its most
  recently edited worktree. The worktree switcher beside it (shown once a
  multi-worktree project is active) is a custom dropdown, not a native
  select, so its closed trigger shows only the current worktree's name (no
  clutter) while the open list sorts worktrees most-recently-edited first,
  each on two lines: the name, then commits-ahead-of-base and a relative
  "edited N ago" time in smaller, dimmer text. A worktree is named by its
  DIRECTORY in the trigger and the rows alike — the switcher picks a place
  on disk — and the branch checked out there gets its own line on the row
  ONLY when it differs from the directory name (a `main` worktree holding
  a feature branch); a detached worktree reads "detached" in its meta.
  What is checked out is the branch indicator's job, and it states the
  branch whenever the switcher is not already showing that exact word.
  The upstream shortens to just the remote when it is the same branch name
  there (`aer-4569-x → origin`, full ref on hover); a different upstream
  branch is spelled out.
- **One worktree source (`stores/worktrees`).** The trigger label, the
  worktree dropdown, the "Open on daemon" rows, and the "Recent" rows all
  read worktree knowledge from a single store keyed by filesystem PATH
  (`GET /worktrees?path=`), with per-entry state (pending / ready /
  absent / failed), one shared request per path in flight, and
  stale-while-revalidate refresh when the open-repo set changes (entries
  are never dropped, so a repo switch cannot empty the Recent list). Because every surface
  derives from the ACTIVE PATH rather than from a list that a fetch
  happens to overwrite, a repo switch of any kind — picker, worktree
  dropdown, follow mode, URL, an SSE reconnect — can never leave the
  previous repo's project on screen, and a slow or failed lookup cannot
  be attributed to the wrong repo.
- **Layout-indifferent project identity.** A project is identified by its
  MAIN worktree (`git worktree list` reports it first; `isMain` on
  `WorktreeInfo`), never by path shape. Every layout groups and names the
  same way: worktrees nested under the repo, parked as siblings
  (`…/proj` + `…/proj-fix`), a bare repo with worktrees around it
  (`…/proj/.bare` → `proj`, `…/proj.git` → `proj`), scattered across
  unrelated directories, or a plain repo with no worktrees at all. A recent path renders only once
  resolved (unresolved worktree siblings would each draw a stray row that
  then folds away); one the daemon reports as no longer a worktree is
  dropped; one it could not answer for still renders by its own path and
  is retried, since an unreachable daemon is not evidence the path is bad.
- **Version indicator** (status bar, far right): the running daemon's version
  (`v0.8.1`), colored only when it is stale — an older version reads
  `v0.8.1 → 0.9.0` in the warn color, a local build ahead of npm shows in the
  accent color, a match stays dim. The daemon answers `GET /version`: it reads
  its own version from its package manifest and compares it with npm's `latest`
  dist-tag, cached for six hours (five minutes after a failed lookup) and only
  ever fetched when a client asks. Offline, or with `--no-update-check`, the
  running version still shows and the comparison reads "unknown"; the indicator
  hides entirely when the daemon cannot read its own version.
- **Click the version to copy the update command.** The same `GET /version`
  reports how the daemon was installed, worked out from where its own files
  live: a global `node_modules` layout names its manager (`npm install -g
  diffstalkerd`, or the bun/pnpm/yarn spelling, prefixed with `sudo` when the
  prefix is root-owned), and anything else is offered to pacman, which answers
  with the owning package (`yay -S diffstalker-git`, `paru` preferred, plain
  `sudo pacman -Syu` with no helper installed). Hovering names the command,
  clicking copies it and the chip flashes `copied`. An install nothing owns — a
  source checkout, a `bun link`, a project-local dependency — gets no command
  and no click: the chip is just text saying what is running, because a wrong
  update command either fails or, with npm's prefix on Arch, plants unowned
  files over a packaged install. A daemon that outran the page (`stale-bundle`)
  offers nothing to copy either; reloading is the fix there, not an update.
- **Auto mode** (header toggle or `a`, persisted): read-only auto-following of
  the newest change — the web port of the CLI's auto mode. When a file's
  content changes on disk, it is auto-selected and its row flashes briefly;
  when the working tree goes clean on Changes, the view switches to History
  with the newest commit selected; when changes appear on History, it switches
  back to Changes. Detection is mtime-based via the daemon's `mtimes` map in
  the shared state (the browser cannot stat files), so staging/SSE churn
  without a content change never causes a jump. Tracking runs even while the
  toggle is off, so turning it on never acts on a stale change, and the first
  snapshot of a repo only seeds.
- **Diff syntax highlighting** (header toggle, persisted): one app-wide switch
  between plain diff text (the default) and highlight.js-tokenized content,
  applied by every diff surface (Changes, Journal, History, Compare) through
  the single shared `DiffView`. Language is detected per file, so a multi-file
  diff highlights each file in its own language; unknown languages and
  over-long lines fall back to plain text. The token colors are theme
  variables (the same mapping the Explorer file viewer uses), and stay
  readable over the add/del row tints. Word-level highlighting composes on
  top — a changed word keeps its background under the syntax colors.
- **Diff layout — unified / split** (header toggle, persisted): one app-wide
  switch between the unified (stacked) diff and a GitHub-style split — old on
  the left, new on the right — again through the single shared `DiffView`, so
  every diff surface flips together. Each hunk pairs deletions with additions
  position-for-position (one visual row per pair, the shorter side padded), so
  a similar del/add pair faces its counterpart with word-diff highlighting
  intact; context lines occupy both sides. The two columns are independent
  horizontal scrollers rendering equal-height rows, so they stay aligned and
  share the vertical scroll. Syntax highlighting composes with split. In the
  stacked-diff views (Changes, Compare) the exact-height virtualization counts
  split rows, so scrolling stays precise in either mode.
- **Wrap long lines** (app-wide, persisted, off by default): a small "Wrap"
  toggle in the corner of each diff pane (Changes, Compare, History) and the
  Explorer file viewer — deliberately understated compared to the header's
  auto/syntax/split toggles, closer to a Notepad/Word "Word Wrap" checkbox
  than a headline display mode. On, long lines break onto multiple visual
  lines instead of needing horizontal scroll. Off by default, wrapped rows
  give up their row-level (and, in Changes/Compare, per-file)
  content-visibility virtualization — a wrapped row's height is no longer a
  known constant, so rather than trust an inexact placeholder the affected
  content just renders in full, unvirtualized. A deliberate, occasional
  opt-in, not the default hot path, so this trade is one-sided: wrap mode
  never causes a wrong-height jump, at the cost of skipping the off-screen
  layout/paint skip for whatever it's turned on for.

### Portrait layout (vertical monitors)

- One trigger — `(orientation: portrait), (max-aspect-ratio: 1/1)` — fires on
  window SHAPE, not width; landscape renders the classic layout untouched.
- The activity rail becomes a full-width horizontal tab band under the header;
  the active view's lifted toolbar (Explorer's filter toggles + refresh,
  Compare's base picker + commits toggle) sits beside the tabs as a
  right-aligned flex item in the same row (via Teleport), wrapping to its own
  line when the band runs out of width.
- Every view rotates column → row: the list/tree/commit band on top (bounded
  height), the diff/content payload full-width below, split by a draggable +
  keyboard-accessible row resizer. Per-view top-band heights persist in
  localStorage (`changesTop` / `historyTop` / `compareTop` / `explorerTop`,
  clamped 10–60%); Changes keeps its landscape column split (`changesSplit`)
  separately.
- Compare's top file band is a jump-index: clicking a file anchor-scrolls the
  stacked diffs to that file's sticky header (never filters to one file).
- Compare's stacked diffs render in the FILE TREE's order — same sequence,
  same directory grouping — so scrolling the diffs walks the tree. (The
  daemon returns git's flat path sort, which differs the moment a
  directory holds both sub-directories and loose files.) Collapsing a
  directory affects the tree only; the diffs never reorder or disappear.
- Portrait keys: j/k move the band selection; Enter selects and focuses the
  payload pane (Tab also reaches it); j/k scroll the focused payload.

### Notes

- The web build ships inside the published `diffstalkerd` tarball (it is not a
  separately published package).
- Several daemons can run side by side: `diffstalkerd --instance NAME` binds
  `<NAME>.sock` in the runtime dir instead of the shared default, and clients
  pick it with the same word (`diffstalker --instance NAME`, or
  `$DIFFSTALKER_INSTANCE`). An explicit `--socket`/`$DIFFSTALKER_SOCKET` path
  still wins, since a path is already unambiguous. This is how the dev server
  (`bun run serve`) coexists with a released daemon on the default socket.
- No authentication; the daemon binds loopback only (unix socket, or `--port`
  on `127.0.0.1` — there is no routable-bind option). On a port it runs an
  origin guard (Host allow-list + cross-site/CSRF rejection) and serves a
  **reduced REST surface**: only the endpoints the web UI uses (reads, repo
  open/release, file stage/unstage). The CLI-only mutations (commit, discard,
  hunk staging, remote/branch ops, persisted compare base) are not routed on a
  port at all. See `SECURITY.md`.
