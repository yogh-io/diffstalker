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
- Binary files show "Binary file" message
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

- Diff view shows "Binary file differs" or similar
- Explorer shows "Binary file" message instead of content

### Large Files

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

### No Repository

- Error shown in header if not in a git repo
- Operations fail gracefully

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
| `[path]` | Fixed repository path |
| `-f, --follow [FILE]` | Enable follow mode, optionally with custom file |
| `-s, --socket PATH` | diffstalkerd socket to attach to or spawn on |
| `-d, --debug` | Enable debug logging |
| `-h, --help` | Show help message |

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
instead of tab-switching). The web UI is **nearly a viewer**: the only git
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
- **Explorer** — a VS Code-style lazy file tree with git-status decoration
  (dotfile / ignored / changed-only toggles) beside syntax-highlighted file
  content (highlight.js) with binary / truncated / too-large states.
  Single-child directory chains collapse onto one combined row
  (`packages/cli/src`) on expand, like the CLI's explorer.

### Header & global

- Branch indicator: current branch → tracking, ahead/behind counts —
  read-only text, no fetch/pull/push controls.
- Repo switcher (open by absolute path, recent repos), follow-mode toggle, theme
  switcher (the same six themes as CSS variables), fuzzy file finder (Ctrl+P),
  and a hotkeys overlay (`?`). Live over SSE, with a calm reconnect banner.
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
- Portrait keys: j/k move the band selection; Enter selects and focuses the
  payload pane (Tab also reaches it); j/k scroll the focused payload.

### Notes

- The web build ships inside the published `diffstalkerd` tarball (it is not a
  separately published package).
- No authentication yet; the daemon binds `127.0.0.1` — keep it on localhost.
