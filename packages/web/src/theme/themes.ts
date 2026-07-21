/**
 * Theme definitions for the diffstalker web UI.
 *
 * The theme names, display names, and DiffColors come from the shared
 * table in @diffstalker/core/view/themes — the same module the CLI uses,
 * so the two can no longer drift (hex stays hex, named ANSI colors
 * resolve through theme/palette.ts at CSS build time).
 *
 * ChromeColors are web-only: the CLI scatters chrome literals across its
 * widgets (file-status colors, selection cyan, magenta-uncommitted, flash
 * yellow); here they are promoted to named per-theme tokens so the whole
 * UI is themeable. The add/del chrome tokens are each theme's diff hues,
 * tone-adjusted for legibility on the chrome background — the --diff-*
 * values themselves stay exact.
 */

import { themes as sharedThemes } from '@diffstalker/core/view/themes';
import type { Theme as SharedTheme, ThemeName } from '@diffstalker/core/view/themes';

export type { ThemeName, DiffColors } from '@diffstalker/core/view/themes';
export { themeOrder, isThemeName } from '@diffstalker/core/view/themes';

/** Web-only chrome tokens (all resolved hex or ANSI names). */
export interface ChromeColors {
  /** Page background. */
  bg: string;
  /** Panel background. */
  surface: string;
  /** Elevated background (menus, inputs). */
  surfaceRaised: string;
  /** Hairline borders. */
  border: string;
  text: string;
  textDim: string;
  /** The one loud color — always the theme's add hue. */
  accent: string;
  /** Selection/focus (the CLI's selection cyan). */
  selection: string;
  /** Add-green carried into chrome (counts, dots, indicators). */
  add: string;
  /** Del-red carried into chrome. */
  del: string;
  warn: string;
  /** File-status colors (the CLI's fileRowFormatters literals). */
  statusModified: string;
  statusAdded: string;
  statusDeleted: string;
  statusUntracked: string;
  statusRenamed: string;
  statusCopied: string;
  /** The CLI's magenta for uncommitted-in-compare. */
  uncommitted: string;
  /** The CLI's flash yellow for freshly-changed rows/hunks. */
  flash: string;
}

/**
 * Syntax-highlighting tokens (web-only, for the Explorer's code viewer).
 * A small set: highlight.js's many token classes collapse onto these
 * eight vars (see FileContentPane.vue for the class → var mapping), so
 * every theme states its whole code palette in eight values.
 */
export interface SyntaxColors {
  /** Keywords, storage words (`const`, `fn`, `class`). */
  keyword: string;
  /** String and regexp literals. */
  string: string;
  /** Comments and quotes. */
  comment: string;
  /** Numeric literals and symbols. */
  number: string;
  /** Built-ins, types, language literals (`true`, `null`). */
  literal: string;
  /** Function/class/section names. */
  title: string;
  /** Attributes, properties, variables, CSS selectors. */
  attr: string;
  /** Meta/preprocessor, punctuation-ish chrome (tags, bullets, links). */
  meta: string;
}

export interface Theme extends SharedTheme {
  /** Whether the browser should treat form controls etc. as dark. */
  scheme: 'dark' | 'light';
  chrome: ChromeColors;
  syntax: SyntaxColors;
}

// Dark theme - sampled from Claude Code's dark mode
const darkTheme: Theme = {
  ...sharedThemes.dark,
  scheme: 'dark',
  chrome: {
    bg: '#0d100f',
    surface: '#131716',
    surfaceRaised: '#1a1f1d',
    border: '#242b28',
    text: '#d7ded9',
    textDim: '#859089',
    accent: '#3fa53d',
    selection: '#43b3bc',
    add: '#3fa53d',
    del: '#c25e5e',
    warn: '#d2b23e',
    statusModified: '#d2b23e',
    statusAdded: '#3fa53d',
    statusDeleted: '#c25e5e',
    statusUntracked: '#859089',
    statusRenamed: '#6f9fdd',
    statusCopied: '#43b3bc',
    uncommitted: '#c678dd',
    flash: '#e5c94b',
  },
  syntax: {
    keyword: '#c678dd',
    string: '#98c379',
    comment: '#6e7a72',
    number: '#d19a66',
    literal: '#56b6c2',
    title: '#61afef',
    attr: '#e5c07b',
    meta: '#859089',
  },
};

// Light theme - matches Claude Code's light mode colors
const lightTheme: Theme = {
  ...sharedThemes.light,
  scheme: 'light',
  chrome: {
    bg: '#f5f6f5',
    surface: '#fcfdfc',
    surfaceRaised: '#eef1ee',
    border: '#d7dcd8',
    text: '#1d231f',
    textDim: '#5d675f',
    accent: '#2f9d44',
    selection: '#0c7f8c',
    // add/del/warn darkened from the diff hues for WCAG AA (>= 4.5:1 as
    // small text on bg AND surface); the --diff-* values stay exact.
    add: '#247a36',
    del: '#c03038',
    warn: '#7a6300',
    statusModified: '#9a7d00',
    statusAdded: '#2f9d44',
    statusDeleted: '#d1454b',
    statusUntracked: '#6c757d',
    statusRenamed: '#3b6fd4',
    statusCopied: '#0c7f8c',
    uncommitted: '#9c36b5',
    flash: '#eac54f',
  },
  syntax: {
    keyword: '#a626a4',
    string: '#2f7d3b',
    comment: '#6a737d',
    number: '#b25e09',
    literal: '#0184bc',
    title: '#4078f2',
    attr: '#986801',
    meta: '#5d675f',
  },
};

// Dark colorblind theme - matches Claude Code's dark-daltonized colors
const darkColorblindTheme: Theme = {
  ...sharedThemes['dark-colorblind'],
  scheme: 'dark',
  chrome: {
    bg: '#0d0f11',
    surface: '#131619',
    surfaceRaised: '#191d21',
    border: '#242a30',
    text: '#d6dce2',
    textDim: '#848f9a',
    accent: '#2596d1',
    selection: '#45b8c9',
    add: '#2596d1',
    del: '#d16060',
    warn: '#d2b23e',
    statusModified: '#d2b23e',
    statusAdded: '#2596d1',
    statusDeleted: '#d16060',
    statusUntracked: '#848f9a',
    statusRenamed: '#6f9fdd',
    statusCopied: '#45b8c9',
    uncommitted: '#c678dd',
    flash: '#e5c94b',
  },
  // No red/green pairs: strings are cyan, not green.
  syntax: {
    keyword: '#c678dd',
    string: '#56b6c2',
    comment: '#7d8894',
    number: '#d19a66',
    literal: '#2596d1',
    title: '#6f9fdd',
    attr: '#e5c07b',
    meta: '#848f9a',
  },
};

// Light colorblind theme - matches Claude Code's light-daltonized colors
const lightColorblindTheme: Theme = {
  ...sharedThemes['light-colorblind'],
  scheme: 'light',
  chrome: {
    bg: '#f4f6f8',
    surface: '#fcfdfe',
    surfaceRaised: '#edf0f3',
    border: '#d5dbe1',
    text: '#1d2126',
    textDim: '#5c6670',
    accent: '#3366cc',
    selection: '#0c7f8c',
    add: '#3366cc',
    del: '#993333',
    // Darkened for WCAG AA on the light chrome (add/del already pass).
    warn: '#7a6300',
    statusModified: '#9a7d00',
    statusAdded: '#3366cc',
    statusDeleted: '#993333',
    statusUntracked: '#6c757d',
    statusRenamed: '#3b6fd4',
    statusCopied: '#0c7f8c',
    uncommitted: '#9c36b5',
    flash: '#eac54f',
  },
  // No red/green pairs: strings are teal, not green.
  syntax: {
    keyword: '#9c36b5',
    string: '#0c7f8c',
    comment: '#6a737d',
    number: '#b25e09',
    literal: '#0184bc',
    title: '#3b6fd4',
    attr: '#986801',
    meta: '#5c6670',
  },
};

// Dark ANSI theme - the terminal's native 16 ANSI colors (xterm values)
const darkAnsiTheme: Theme = {
  ...sharedThemes['dark-ansi'],
  scheme: 'dark',
  chrome: {
    bg: '#000000',
    surface: '#121212',
    surfaceRaised: '#1c1c1c',
    border: '#3a3a3a',
    text: '#e5e5e5',
    textDim: '#7f7f7f',
    accent: '#00ff00',
    selection: '#00cdcd',
    add: '#00ff00',
    del: '#ff0000',
    warn: '#cdcd00',
    statusModified: '#cdcd00',
    statusAdded: '#00cd00',
    statusDeleted: '#cd0000',
    statusUntracked: '#7f7f7f',
    statusRenamed: '#5c5cff',
    statusCopied: '#00cdcd',
    uncommitted: '#cd00cd',
    flash: '#ffff00',
  },
  // Terminal identity: xterm's 16-color values only.
  syntax: {
    keyword: '#cd00cd',
    string: '#00cd00',
    comment: '#7f7f7f',
    number: '#cdcd00',
    literal: '#00cdcd',
    title: '#5c5cff',
    attr: '#cdcd00',
    meta: '#7f7f7f',
  },
};

// Light ANSI theme - the terminal's native 16 ANSI colors (xterm values)
const lightAnsiTheme: Theme = {
  ...sharedThemes['light-ansi'],
  scheme: 'light',
  chrome: {
    bg: '#ffffff',
    surface: '#f5f5f5',
    surfaceRaised: '#ebebeb',
    border: '#c0c0c0',
    text: '#000000',
    textDim: '#7f7f7f',
    accent: '#00a000',
    selection: '#00a3a3',
    // add/warn darkened for WCAG AA on the light chrome (del passes).
    add: '#007700',
    del: '#cd0000',
    warn: '#6e6e00',
    statusModified: '#a0a000',
    statusAdded: '#00a000',
    statusDeleted: '#cd0000',
    statusUntracked: '#7f7f7f',
    statusRenamed: '#0000ee',
    statusCopied: '#00a3a3',
    uncommitted: '#cd00cd',
    flash: '#ffff00',
  },
  // Terminal identity, darkened where xterm's values are unreadable on white.
  syntax: {
    keyword: '#cd00cd',
    string: '#00a000',
    comment: '#7f7f7f',
    number: '#a0a000',
    literal: '#00a3a3',
    title: '#0000ee',
    attr: '#a0a000',
    meta: '#7f7f7f',
  },
};

export const themes: Record<ThemeName, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  'dark-colorblind': darkColorblindTheme,
  'light-colorblind': lightColorblindTheme,
  'dark-ansi': darkAnsiTheme,
  'light-ansi': lightAnsiTheme,
};
