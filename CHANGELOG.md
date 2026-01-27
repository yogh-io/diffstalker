# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-01-27

### Changed

- **Major rewrite**: Migrated from Ink (React for CLIs) to neo-blessed for native terminal rendering
- Significantly improved scroll performance - no more lag on large diffs
- More responsive UI with direct terminal control
- Reduced memory footprint
- Gitignore-aware file watching - no longer watches inside node_modules, dist, etc.

### Added

- Base branch picker modal (`b` in Compare view) for selecting PR comparison base
- Discard confirmation dialog (`d` on unstaged files) with y/n prompt
- Toggle uncommitted changes in Compare view (`u`)
- External git operation detection - UI updates when staging/committing outside the app
- Explorer view (tab 5) for browsing repository files with syntax highlighting
- tmux-test.sh script for headless UI testing

### Fixed

- Window resize now properly updates all UI elements
- Diff content no longer contains control characters
- Improved diff line alignment and file separation

### Technical

- Replaced React hooks with event-driven state management
- Single source of truth pattern for scroll calculations
- Operation queue for serialized git operations
- Polling-based git watcher for reliable atomic write detection

## [0.1.0] - 2026-01-21

### Added

- Initial release
- Four views: Diff, Commit, History, and PR comparison
- Two-pane layout with resizable split
- Mouse support: click to select, stage/unstage, scroll, switch tabs
- Word-level diff highlighting
- 6 color themes including colorblind-friendly and ANSI-only variants
- Follow mode for shell integration
- Keyboard navigation with vim-style bindings
