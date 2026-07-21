/**
 * Theme system tests. The diff palette, theme names, and display names now
 * live once in @diffstalker/core/view/themes (the CLI reads the same table).
 * The parity guard here asserts the web theme objects surface that shared
 * table unchanged — they compose it (spread + web-only chrome/syntax) and
 * must not fork the diff colors — so a web-side override of a shared value
 * fails this suite. Core's own themes.test.ts covers the shared table itself.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { themes, themeOrder, isThemeName } from './themes';
import { ANSI_COLORS, resolveColor } from './palette';
import { buildThemeCss, installThemeStyles } from './css';
import { themes as coreThemes } from '@diffstalker/core/view/themes';

describe('themes', () => {
  test('the web theme record holds exactly the shared themes', () => {
    expect(Object.keys(themes).sort()).toEqual([...themeOrder].sort());
  });

  test.each(themeOrder)('%s surfaces the shared DiffColors unchanged', (name) => {
    expect(themes[name].colors).toEqual(coreThemes[name].colors);
  });

  test('display names come from the shared table', () => {
    expect(themeOrder.map((name) => themes[name].displayName)).toEqual(
      themeOrder.map((name) => coreThemes[name].displayName)
    );
  });

  test('isThemeName accepts the six and rejects anything else', () => {
    for (const name of themeOrder) expect(isThemeName(name)).toBe(true);
    expect(isThemeName('solarized')).toBe(false);
    expect(isThemeName(null)).toBe(false);
  });
});

describe('palette', () => {
  test('hex passes through (lowercased), names resolve via the ANSI map', () => {
    expect(resolveColor('#3D0100')).toBe('#3d0100');
    expect(resolveColor('greenBright')).toBe(ANSI_COLORS.greenBright);
    expect(resolveColor('gray')).toBe('#7f7f7f');
    expect(resolveColor('white')).toBe('#e5e5e5');
  });

  test('unknown names throw', () => {
    expect(() => resolveColor('mauve')).toThrow('unknown color name');
  });
});

describe('buildThemeCss', () => {
  const css = buildThemeCss();

  test('emits one data-theme block per theme', () => {
    for (const name of themeOrder) {
      expect(css).toContain(`:root[data-theme='${name}']`);
    }
  });

  test('diff vars carry the exact CLI hex', () => {
    expect(css).toContain('--diff-add-bg: #022800;'); // dark
    expect(css).toContain('--diff-del-bg: #3d0100;'); // dark (lowercased)
    expect(css).toContain('--diff-add-bg: #69db7c;'); // light
    expect(css).toContain('--diff-add-highlight: #0077b3;'); // dark-colorblind
    expect(css).toContain('--diff-add-bg: #00cd00;'); // ansi: green resolved
  });

  test('every block carries the full chrome token set', () => {
    for (const token of ['--bg:', '--surface:', '--accent:', '--selection:', '--flash:']) {
      const count = css.split(token).length - 1;
      expect(count).toBe(themeOrder.length);
    }
  });

  test('every block carries the syntax token set', () => {
    for (const token of ['--syn-keyword:', '--syn-string:', '--syn-comment:', '--syn-meta:']) {
      const count = css.split(token).length - 1;
      expect(count).toBe(themeOrder.length);
    }
  });

  test('color-scheme follows the theme', () => {
    expect(css.split('color-scheme: dark;').length - 1).toBe(3);
    expect(css.split('color-scheme: light;').length - 1).toBe(3);
  });
});

describe('installThemeStyles', () => {
  beforeEach(() => {
    document.getElementById('diffstalker-themes')?.remove();
  });

  test('injects the stylesheet once (idempotent)', () => {
    installThemeStyles();
    installThemeStyles();
    const styles = document.querySelectorAll('#diffstalker-themes');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain("--diff-add-bg: #022800;");
  });
});
