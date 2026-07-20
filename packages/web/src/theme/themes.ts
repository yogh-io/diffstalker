/**
 * Theme definitions for the diffstalker web UI.
 *
 * DiffColors are ported verbatim from the CLI (packages/cli/src/themes.ts)
 * — same 6 themes, same 10 fields, byte-identical values (hex stays hex,
 * named ANSI colors resolve through theme/palette.ts at CSS build time).
 * Keep the two files in sync when a theme changes.
 *
 * ChromeColors are web-only: the CLI scatters chrome literals across its
 * widgets (file-status colors, selection cyan, magenta-uncommitted, flash
 * yellow); here they are promoted to named per-theme tokens so the whole
 * UI is themeable. The add/del chrome tokens are each theme's diff hues,
 * tone-adjusted for legibility on the chrome background — the --diff-*
 * values themselves stay exact.
 */

export type ThemeName =
  | 'dark'
  | 'light'
  | 'dark-colorblind'
  | 'light-colorblind'
  | 'dark-ansi'
  | 'light-ansi';

/** The 10 diff colors, exactly as the CLI defines them. */
export interface DiffColors {
  addBg: string;
  delBg: string;
  addHighlight: string;
  delHighlight: string;
  text: string;
  addLineNum: string;
  delLineNum: string;
  contextLineNum: string;
  addSymbol: string;
  delSymbol: string;
}

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

export interface Theme {
  name: ThemeName;
  displayName: string;
  /** Whether the browser should treat form controls etc. as dark. */
  scheme: 'dark' | 'light';
  colors: DiffColors;
  chrome: ChromeColors;
}

// Dark theme - sampled from Claude Code's dark mode
const darkTheme: Theme = {
  name: 'dark',
  displayName: 'Dark',
  scheme: 'dark',
  colors: {
    addBg: '#022800',
    delBg: '#3D0100',
    addHighlight: '#044700',
    delHighlight: '#5C0200',
    text: 'white',
    addLineNum: '#368F35',
    delLineNum: '#A14040',
    contextLineNum: 'gray',
    addSymbol: 'greenBright',
    delSymbol: 'redBright',
  },
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
};

// Light theme - matches Claude Code's light mode colors
const lightTheme: Theme = {
  name: 'light',
  displayName: 'Light',
  scheme: 'light',
  colors: {
    addBg: '#69db7c',
    delBg: '#ffa8b4',
    addHighlight: '#2f9d44',
    delHighlight: '#d1454b',
    text: 'black',
    addLineNum: '#2f9d44',
    delLineNum: '#d1454b',
    contextLineNum: '#6c757d',
    addSymbol: 'green',
    delSymbol: 'red',
  },
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
};

// Dark colorblind theme - matches Claude Code's dark-daltonized colors
const darkColorblindTheme: Theme = {
  name: 'dark-colorblind',
  displayName: 'Dark (colorblind)',
  scheme: 'dark',
  colors: {
    addBg: '#004466',
    delBg: '#660000',
    addHighlight: '#0077b3',
    delHighlight: '#b30000',
    text: 'white',
    addLineNum: '#0077b3',
    delLineNum: '#b30000',
    contextLineNum: 'gray',
    addSymbol: 'cyanBright',
    delSymbol: 'redBright',
  },
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
};

// Light colorblind theme - matches Claude Code's light-daltonized colors
const lightColorblindTheme: Theme = {
  name: 'light-colorblind',
  displayName: 'Light (colorblind)',
  scheme: 'light',
  colors: {
    addBg: '#99ccff',
    delBg: '#ffcccc',
    addHighlight: '#3366cc',
    delHighlight: '#993333',
    text: 'black',
    addLineNum: '#3366cc',
    delLineNum: '#993333',
    contextLineNum: '#6c757d',
    addSymbol: 'blue',
    delSymbol: 'red',
  },
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
};

// Dark ANSI theme - the terminal's native 16 ANSI colors (xterm values)
const darkAnsiTheme: Theme = {
  name: 'dark-ansi',
  displayName: 'Dark (ANSI)',
  scheme: 'dark',
  colors: {
    addBg: 'green',
    delBg: 'red',
    addHighlight: 'greenBright',
    delHighlight: 'redBright',
    text: 'white',
    addLineNum: 'greenBright',
    delLineNum: 'redBright',
    contextLineNum: 'gray',
    addSymbol: 'greenBright',
    delSymbol: 'redBright',
  },
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
};

// Light ANSI theme - the terminal's native 16 ANSI colors (xterm values)
const lightAnsiTheme: Theme = {
  name: 'light-ansi',
  displayName: 'Light (ANSI)',
  scheme: 'light',
  colors: {
    addBg: 'green',
    delBg: 'red',
    addHighlight: 'greenBright',
    delHighlight: 'redBright',
    text: 'black',
    addLineNum: 'green',
    delLineNum: 'red',
    contextLineNum: 'gray',
    addSymbol: 'green',
    delSymbol: 'red',
  },
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
};

export const themes: Record<ThemeName, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  'dark-colorblind': darkColorblindTheme,
  'light-colorblind': lightColorblindTheme,
  'dark-ansi': darkAnsiTheme,
  'light-ansi': lightAnsiTheme,
};

export const themeOrder: ThemeName[] = [
  'dark',
  'light',
  'dark-colorblind',
  'light-colorblind',
  'dark-ansi',
  'light-ansi',
];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (themeOrder as string[]).includes(value);
}
