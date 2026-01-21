// Theme definitions for diffstalker

export type ThemeName =
  | 'dark'
  | 'light'
  | 'dark-colorblind'
  | 'light-colorblind'
  | 'dark-ansi'
  | 'light-ansi';

export interface DiffColors {
  // Line backgrounds
  addBg: string;
  delBg: string;
  // Word-level change highlights
  addHighlight: string;
  delHighlight: string;
  // Text colors
  text: string;
  // Line number colors (per line type)
  addLineNum: string;
  delLineNum: string;
  contextLineNum: string;
  // Symbol colors (+/-)
  addSymbol: string;
  delSymbol: string;
}

export interface Theme {
  name: ThemeName;
  displayName: string;
  colors: DiffColors;
}

// Dark theme - sampled from Claude Code's dark mode
const darkTheme: Theme = {
  name: 'dark',
  displayName: 'Dark',
  colors: {
    addBg: '#022800', // sampled: rgb(2,40,0)
    delBg: '#3D0100', // sampled: rgb(61,1,0)
    addHighlight: '#044700', // sampled: rgb(4,71,0)
    delHighlight: '#5C0200', // sampled: rgb(92,2,0)
    text: 'white',
    addLineNum: '#368F35', // sampled: rgb(54,143,53)
    delLineNum: '#A14040', // sampled: rgb(161,64,64)
    contextLineNum: 'gray',
    addSymbol: 'greenBright',
    delSymbol: 'redBright',
  },
};

// Light theme - matches Claude Code's light mode colors
const lightTheme: Theme = {
  name: 'light',
  displayName: 'Light',
  colors: {
    addBg: '#69db7c', // rgb(105,219,124)
    delBg: '#ffa8b4', // rgb(255,168,180)
    addHighlight: '#2f9d44', // rgb(47,157,68)
    delHighlight: '#d1454b', // rgb(209,69,75)
    text: 'black',
    addLineNum: '#2f9d44',
    delLineNum: '#d1454b',
    contextLineNum: '#6c757d',
    addSymbol: 'green',
    delSymbol: 'red',
  },
};

// Dark colorblind theme - matches Claude Code's dark-daltonized colors
const darkColorblindTheme: Theme = {
  name: 'dark-colorblind',
  displayName: 'Dark (colorblind)',
  colors: {
    addBg: '#004466', // rgb(0,68,102)
    delBg: '#660000', // rgb(102,0,0)
    addHighlight: '#0077b3', // rgb(0,119,179)
    delHighlight: '#b30000', // rgb(179,0,0)
    text: 'white',
    addLineNum: '#0077b3',
    delLineNum: '#b30000',
    contextLineNum: 'gray',
    addSymbol: 'cyanBright',
    delSymbol: 'redBright',
  },
};

// Light colorblind theme - matches Claude Code's light-daltonized colors
const lightColorblindTheme: Theme = {
  name: 'light-colorblind',
  displayName: 'Light (colorblind)',
  colors: {
    addBg: '#99ccff', // rgb(153,204,255)
    delBg: '#ffcccc', // rgb(255,204,204)
    addHighlight: '#3366cc', // rgb(51,102,204)
    delHighlight: '#993333', // rgb(153,51,51)
    text: 'black',
    addLineNum: '#3366cc',
    delLineNum: '#993333',
    contextLineNum: '#6c757d',
    addSymbol: 'blue',
    delSymbol: 'red',
  },
};

// Dark ANSI theme - uses terminal's native 16 ANSI colors
const darkAnsiTheme: Theme = {
  name: 'dark-ansi',
  displayName: 'Dark (ANSI)',
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
};

// Light ANSI theme - uses terminal's native 16 ANSI colors
const lightAnsiTheme: Theme = {
  name: 'light-ansi',
  displayName: 'Light (ANSI)',
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

export function getTheme(name: ThemeName): Theme {
  return themes[name] ?? themes['dark'];
}

export function getNextTheme(current: ThemeName): ThemeName {
  const currentIndex = themeOrder.indexOf(current);
  const nextIndex = (currentIndex + 1) % themeOrder.length;
  return themeOrder[nextIndex];
}
