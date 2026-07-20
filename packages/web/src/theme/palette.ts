/**
 * Named terminal colors → hex. The CLI hands blessed named ANSI colors
 * (greenBright, gray, white, ...) and lets the terminal's palette resolve
 * them; a browser has no palette, so the web resolves them here with the
 * standard xterm 16-color values. Hex values in a theme pass through
 * untouched — only names are mapped.
 */

export const ANSI_COLORS: Record<string, string> = {
  black: '#000000',
  red: '#cd0000',
  green: '#00cd00',
  yellow: '#cdcd00',
  blue: '#0000ee',
  magenta: '#cd00cd',
  cyan: '#00cdcd',
  white: '#e5e5e5',
  gray: '#7f7f7f',
  grey: '#7f7f7f',
  blackBright: '#7f7f7f',
  redBright: '#ff0000',
  greenBright: '#00ff00',
  yellowBright: '#ffff00',
  blueBright: '#5c5cff',
  magentaBright: '#ff00ff',
  cyanBright: '#00ffff',
  whiteBright: '#ffffff',
};

/** Resolve a theme color value (hex passes through, names map to hex). */
export function resolveColor(value: string): string {
  if (value.startsWith('#')) return value.toLowerCase();
  const hex = ANSI_COLORS[value];
  if (!hex) throw new Error(`unknown color name: ${value}`);
  return hex;
}
