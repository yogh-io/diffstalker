/**
 * Syntax highlighting utilities for terminal output.
 * Uses the emphasize package for ANSI terminal colors.
 */

import { createEmphasize } from 'emphasize';
import { common } from 'lowlight';
import { getLanguageFromPath } from '@diffstalker/core/view/languageDetection';
import { ANSI_FG_RESET } from './ansi.js';

// Create emphasize instance with common languages
const emphasize = createEmphasize(common);

// The languages emphasize can actually highlight (the bundled `common` set).
const availableLanguages = new Set(emphasize.listLanguages());

/**
 * Detect a file's language, but only when emphasize can actually highlight it —
 * returns null for anything outside the bundled `common` set so callers skip the
 * highlight path entirely. The pure `getLanguageFromPath` in core no longer does
 * this availability filter (a browser highlighter has a different language set),
 * so the terminal does it here. This keeps the CLI's output byte-identical to
 * before the shared-logic extraction and avoids a throw-per-line on unsupported
 * files (Dockerfile, .zig, .scala, ...) during rendering.
 */
export function getSupportedLanguage(filePath: string): string | null {
  const language = getLanguageFromPath(filePath);
  return language && availableLanguages.has(language) ? language : null;
}

/**
 * Apply syntax highlighting to a line of code.
 * Returns the highlighted string with ANSI escape codes.
 * If highlighting fails, returns the original content.
 * Skips highlighting for lines that look like comments (heuristic for multi-line context).
 */
export function highlightLine(content: string, language: string): string {
  if (!content || !language) return content;

  try {
    const result = emphasize.highlight(language, content);
    return result.value;
  } catch {
    // If highlighting fails, return original content
    return content;
  }
}

/**
 * Highlight multiple lines as a block, preserving multi-line context
 * (e.g., block comments, multi-line strings) and background color.
 * Returns an array of highlighted lines with foreground-only resets.
 */
export function highlightBlockPreserveBg(lines: string[], language: string): string[] {
  if (!language || lines.length === 0) return lines;

  try {
    const block = lines.join('\n');
    const result = emphasize.highlight(language, block);
    // Replace full resets with foreground-only resets
    const highlighted = result.value.replace(/\x1b\[0m/g, ANSI_FG_RESET);
    return highlighted.split('\n');
  } catch {
    return lines;
  }
}
