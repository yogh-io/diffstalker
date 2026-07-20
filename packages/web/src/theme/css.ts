/**
 * Builds the theme stylesheet: one `:root[data-theme="<name>"]` block per
 * theme, each setting the 10 --diff-* vars plus the chrome tokens. The
 * generated text is injected once as a <style> element at startup
 * (installThemeStyles), so the TS theme table stays the single source.
 */

import { resolveColor } from './palette';
import { themeOrder, themes } from './themes';
import type { ChromeColors, DiffColors, Theme } from './themes';

function diffVars(colors: DiffColors): string[] {
  return [
    `--diff-add-bg: ${resolveColor(colors.addBg)};`,
    `--diff-del-bg: ${resolveColor(colors.delBg)};`,
    `--diff-add-highlight: ${resolveColor(colors.addHighlight)};`,
    `--diff-del-highlight: ${resolveColor(colors.delHighlight)};`,
    `--diff-text: ${resolveColor(colors.text)};`,
    `--diff-add-line-num: ${resolveColor(colors.addLineNum)};`,
    `--diff-del-line-num: ${resolveColor(colors.delLineNum)};`,
    `--diff-context-line-num: ${resolveColor(colors.contextLineNum)};`,
    `--diff-add-symbol: ${resolveColor(colors.addSymbol)};`,
    `--diff-del-symbol: ${resolveColor(colors.delSymbol)};`,
  ];
}

function chromeVars(chrome: ChromeColors): string[] {
  return [
    `--bg: ${chrome.bg};`,
    `--surface: ${chrome.surface};`,
    `--surface-raised: ${chrome.surfaceRaised};`,
    `--border: ${chrome.border};`,
    `--text: ${chrome.text};`,
    `--text-dim: ${chrome.textDim};`,
    `--accent: ${chrome.accent};`,
    `--selection: ${chrome.selection};`,
    `--add: ${chrome.add};`,
    `--del: ${chrome.del};`,
    `--warn: ${chrome.warn};`,
    `--status-modified: ${chrome.statusModified};`,
    `--status-added: ${chrome.statusAdded};`,
    `--status-deleted: ${chrome.statusDeleted};`,
    `--status-untracked: ${chrome.statusUntracked};`,
    `--status-renamed: ${chrome.statusRenamed};`,
    `--status-copied: ${chrome.statusCopied};`,
    `--uncommitted: ${chrome.uncommitted};`,
    `--flash: ${chrome.flash};`,
  ];
}

function themeBlock(theme: Theme): string {
  const lines = [`color-scheme: ${theme.scheme};`, ...chromeVars(theme.chrome), ...diffVars(theme.colors)];
  return `:root[data-theme='${theme.name}'] {\n  ${lines.join('\n  ')}\n}`;
}

export function buildThemeCss(): string {
  return themeOrder.map((name) => themeBlock(themes[name])).join('\n\n') + '\n';
}

/** Inject the generated theme stylesheet once. Idempotent. */
export function installThemeStyles(doc: Document = document): void {
  const id = 'diffstalker-themes';
  if (doc.getElementById(id)) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = buildThemeCss();
  doc.head.appendChild(style);
}
