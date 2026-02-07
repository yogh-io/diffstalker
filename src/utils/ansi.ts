/**
 * Centralized ANSI escape code constants and helpers.
 *
 * All terminal color/style codes live here to avoid duplication across widgets.
 * Terminal mode sequences (mouse mode, cursor visibility) are NOT included —
 * those are a different concern and remain in index.ts.
 */

// --- SGR 3/4-bit color and style constants ---

export const ANSI_RESET = '\x1b[0m';
export const ANSI_BOLD = '\x1b[1m';
export const ANSI_INVERSE = '\x1b[7m';

export const ANSI_RED = '\x1b[31m';
export const ANSI_GREEN = '\x1b[32m';
export const ANSI_YELLOW = '\x1b[33m';
export const ANSI_BLUE = '\x1b[34m';
export const ANSI_MAGENTA = '\x1b[35m';
export const ANSI_CYAN = '\x1b[36m';
export const ANSI_GRAY = '\x1b[90m';

/** Reset foreground color only (preserves background). */
export const ANSI_FG_RESET = '\x1b[39m';

// --- ANSI escape sequence pattern for parsing/stripping ---

/** Matches SGR sequences like \x1b[32m, \x1b[0m, \x1b[1;34m, \x1b[48;2;30;30;30m */
export const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// --- 24-bit RGB helpers ---

/** Build ANSI escape for 24-bit RGB background from hex color (e.g. '#1e1e2e'). */
export function ansiBg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Build ANSI escape for 24-bit RGB foreground from hex color (e.g. '#e0e0e0'). */
export function ansiFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}
