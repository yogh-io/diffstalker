import blessed from 'neo-blessed';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * neo-blessed packs colors as 9-bit values (0-511) in its cell attribute
 * format: 0-255 address the 256-color palette and 511 means "default",
 * leaving 256-510 unused. We claim that range as handles into an RGB lookup
 * table: truecolor SGR sequences in content (38;2;R;G;B / 48;2;R;G;B)
 * register a handle when parsed, and the draw loop emits the original 24-bit
 * sequence when it encounters one.
 */
const RGB_HANDLE_BASE = 256;
const RGB_HANDLE_MAX = 510;

const TRUECOLOR_SGR = /\b(38|48);2;(\d+);(\d+);(\d+)/g;

/** Box-drawing characters `draw()` treats as angles (module-private in screen.js). */
const ANGLES: Record<string, boolean> = {
  '┘': true,
  '┐': true,
  '┌': true,
  '└': true,
  '┼': true,
  '├': true,
  '┤': true,
  '┴': true,
  '┬': true,
  '│': true,
  '─': true,
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Patch neo-blessed at runtime to render 24-bit RGB colors.
 *
 * Must run before the first `blessed.screen()` call. Idempotent. This
 * replaces the former postinstall script that rewrote
 * node_modules/neo-blessed on disk, which never worked for npm consumers
 * (the script was excluded from the published tarball, and its
 * `__dirname`-relative path check silently no-ops under hoisting).
 */
export function applyBlessedRgbPatch(): void {
  const lib = blessed as any;
  const colors = lib.colors;
  if (colors.registerRgb) {
    // Already applied, or a legacy file-patched neo-blessed is installed.
    return;
  }

  const byHandle = new Map<number, Rgb>();
  const byColor = new Map<number, number>();
  let nextHandle = RGB_HANDLE_BASE;

  colors.registerRgb = (r: number, g: number, b: number): number => {
    const color = (r << 16) | (g << 8) | b;
    const existing = byColor.get(color);
    if (existing !== undefined) {
      return existing;
    }
    if (nextHandle > RGB_HANDLE_MAX) {
      // All 255 handles in use: recycle the range. Cells holding a recycled
      // handle render a stale color until redrawn; diff highlighting uses a
      // few dozen distinct colors, so this is theoretical.
      byHandle.clear();
      byColor.clear();
      nextHandle = RGB_HANDLE_BASE;
    }
    const handle = nextHandle++;
    byHandle.set(handle, { r, g, b });
    byColor.set(color, handle);
    return handle;
  };

  colors.getRgb = (handle: number): Rgb | null => byHandle.get(handle) ?? null;

  const screenProto = lib.Screen.prototype;
  patchAttrCode(screenProto, colors);
  patchCodeAttr(screenProto, colors);
  patchDraw(screenProto, colors, lib.unicode);
}

/**
 * attrCode() parses an SGR sequence into the packed attr format and would
 * downsample truecolor to the 256-color palette. Rewrite truecolor sequences
 * to the `;5;` form carrying an RGB handle; the stock parser stores any
 * numeric value verbatim for that form.
 */
function patchAttrCode(screenProto: any, colors: any): void {
  const original = screenProto.attrCode;
  screenProto.attrCode = function (code: string, cur: number, def: number): number {
    if (code.includes(';2;')) {
      code = code.replace(
        TRUECOLOR_SGR,
        (_match, base, r, g, b) =>
          `${base};5;${colors.registerRgb(Number(r), Number(g), Number(b))}`
      );
    }
    return original.call(this, code, cur, def);
  };
}

/**
 * codeAttr() converts a packed attr back to an SGR string (used on the
 * back-color-erase fast path in draw()). Reimplemented with RGB handle
 * support; otherwise identical to the stock version.
 */
function patchCodeAttr(screenProto: any, colors: any): void {
  const colorSgr = (reduced: number, isBg: boolean): string => {
    const rgb = colors.getRgb(reduced);
    if (rgb) return `${isBg ? 48 : 38};2;${rgb.r};${rgb.g};${rgb.b};`;
    if (reduced < 8) return `${reduced + (isBg ? 40 : 30)};`;
    if (reduced < 16) return `${reduced - 8 + (isBg ? 100 : 90)};`;
    return `${isBg ? 48 : 38};5;${reduced};`;
  };

  screenProto.codeAttr = function (code: number): string {
    const flags = (code >> 18) & 0x1ff;
    const fg = (code >> 9) & 0x1ff;
    const bg = code & 0x1ff;
    let out = '';

    if (flags & 1) out += '1;'; // bold
    if (flags & 2) out += '4;'; // underline
    if (flags & 4) out += '5;'; // blink
    if (flags & 8) out += '7;'; // inverse
    if (flags & 16) out += '8;'; // invisible

    if (bg !== 0x1ff) out += colorSgr(this._reduceColor(bg), true);
    if (fg !== 0x1ff) out += colorSgr(this._reduceColor(fg), false);

    if (out.endsWith(';')) out = out.slice(0, -1);
    return `\x1b[${out}m`;
  };
}

/**
 * draw() inlines its own attr-to-SGR conversion, so it cannot be wrapped;
 * rebuild it from its own source with 24-bit emission added where it would
 * write `48;5;`/`38;5;` for palette indices. RGB handles are only ever
 * >= 256, so `getRgb` returning an entry is the discriminator.
 *
 * The rebuilt function loses screen.js's module scope; `colors`, `unicode`,
 * and the `angles` table are the only module-level bindings draw() uses, and
 * they are re-supplied here. neo-blessed is pinned exactly, so the source
 * shape is stable; if it ever changes, fail loudly rather than render
 * truecolor handles as garbage `48;5;N` codes.
 */
function patchDraw(screenProto: any, colors: any, unicode: any): void {
  const source: string = screenProto.draw.toString();

  // Quote-agnostic: node returns the original source (single quotes), bun
  // returns its reprinted form (double quotes, hex literals normalized).
  const bgPlain = /out \+= ["']48;5;["'] \+ bg \+ ["'];["'];/;
  const fgPlain = /out \+= ["']38;5;["'] \+ fg \+ ["'];["'];/;
  const bgRgb =
    "{ var rgbBg = colors.getRgb(bg); if (rgbBg) { out += '48;2;' + rgbBg.r + ';' + rgbBg.g + ';' + rgbBg.b + ';'; } else { out += '48;5;' + bg + ';'; } }";
  const fgRgb =
    "{ var rgbFg = colors.getRgb(fg); if (rgbFg) { out += '38;2;' + rgbFg.r + ';' + rgbFg.g + ';' + rgbFg.b + ';'; } else { out += '38;5;' + fg + ';'; } }";

  if (!bgPlain.test(source) || !fgPlain.test(source)) {
    throw new Error(
      'diffstalker: neo-blessed Screen.draw() has an unexpected shape; cannot apply the 24-bit RGB patch'
    );
  }

  const patched = source.replace(bgPlain, bgRgb).replace(fgPlain, fgRgb);
  // The "dynamic" source is neo-blessed's own draw() with two literal
  // substitutions verified above — no external input reaches it.
  // eslint-disable-next-line sonarjs/code-eval
  screenProto.draw = new Function('colors', 'unicode', 'angles', `return (${patched});`)(
    colors,
    unicode,
    ANGLES
  );
}
