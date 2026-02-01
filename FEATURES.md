# FEATURES.md

Exhaustive feature inventory for diffstalker. This document serves as a migration checklist for future framework changes.

---

## Table of Contents

1. [Views](#views)
2. [Keyboard Shortcuts](#keyboard-shortcuts)
3. [Mouse Interactions](#mouse-interactions)
4. [Scrolling Architecture](#scrolling-architecture)
5. [Themes](#themes)
6. [Edge Cases](#edge-cases)
7. [Configuration](#configuration)

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
  - **Combined diff**: Diff pane shows all hunks for the file in a single view with section headers
    - `── Unstaged changes ──` (cyan) followed by unstaged hunks
    - `── Staged changes ──` (green) followed by staged hunks
    - Hunks never disappear when staged/unstaged — they move between sections
    - Hunk gutter indicator: cyan for unstaged hunks, green for staged hunks
    - `s`/`u` in diff pane stages/unstages the hunk under cursor based on its section

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
- **Hunk Staging**: When diff pane is focused (via `Tab`), a cyan gutter indicator (`▎`) marks the selected hunk. Footer shows `hunk 1/3` position. Use `n`/`N` to navigate between hunks and `s`/`u` to stage/unstage individual hunks instead of entire files. Disabled for untracked files and binary files.

### Tab 2: Commit Panel

**Top Pane: File List** (same as Diff View)

**Bottom Pane: Commit Form**
- Header: "COMMIT [X staged]" showing count
- Text input field for commit message
  - Multi-line support
  - Placeholder: "Enter commit message..."
- Amend checkbox: `[ ] Amend` (toggle with `a` when focused)
  - When checked, loads previous commit message
- Footer hints: Enter to commit, Esc to cancel, Tab to switch fields

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
- Fuzzy search across all files in repo
- Real-time filtering as you type
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
| `Tab` | Toggle pane focus | All views |
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
| `d` | Discard changes (unstaged modified files only, with confirmation) |
| `r` / `Ctrl+R` | Refresh git status |
| `q` / `Ctrl+C` | Quit application |

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
| `Enter` | Submit commit |
| `Esc` | Cancel and return to Diff view |
| `a` | Toggle amend mode |

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

**Layout Calculations:**
- `getMaxScrollOffset(totalItems, maxHeight)` - maximum valid scroll offset
- `getRowForFileIndex(index, mod, untracked, staged)` - file index to display row
- `getFileListTotalRows(files)` - total rows including headers/spacers
- `calculateScrollOffset(selectedRow, currentOffset, visibleHeight)` - auto-scroll

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
| `--once` | Show status once and exit |
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
- Close with Esc, Enter, or `?`

### Base Branch Picker Modal

- List of candidate base branches
- Current branch highlighted
- Text input for filtering (if many branches)
- Close with Esc

### Discard Confirmation

- Inline prompt: "Discard changes to <file>? (y/n)"
- `y` confirms, `n` or Esc cancels

### File Finder Modal

- Fuzzy file search across entire repository
- Text input for search query
- Top 15 results shown with match highlighting
- Navigate with Ctrl+j/k, Up/Down, or Tab
- Select with Enter, cancel with Escape
- Automatically expands tree to show selected file

---

## Auto-Tab Mode

When enabled (`a` toggle):
- Files appearing: auto-switch to Diff view
- Files disappearing (commit): auto-switch to History view
- Shows newest commit after commit
