#!/usr/bin/env node
/**
 * Patch neo-blessed to support 24-bit RGB colors
 *
 * This script modifies node_modules/neo-blessed/lib/widgets/screen.js to:
 * 1. Add an RGB lookup table for colors 256-510
 * 2. Register 24-bit RGB values when parsing \x1b[48;2;R;G;Bm codes
 * 3. Output 24-bit RGB codes for registered colors instead of 256-color
 */

const fs = require('fs');
const path = require('path');

const screenPath = path.join(__dirname, '../node_modules/neo-blessed/lib/widgets/screen.js');

if (!fs.existsSync(screenPath)) {
  console.log('neo-blessed not installed, skipping patch');
  process.exit(0);
}

let content = fs.readFileSync(screenPath, 'utf8');

// Check if already patched
if (content.includes('PATCHED: Added 24-bit RGB color support')) {
  console.log('neo-blessed already patched for 24-bit RGB');
  process.exit(0);
}

// Patch 1: Add header comment and RGB lookup table after the Box require
const boxRequire = "var Box = require('./box');";
const rgbLookupCode = `var Box = require('./box');

/**
 * PATCHED: Added 24-bit RGB color support via lookup table
 * Colors 256-510 are indices into rgbLookup table
 */
var rgbLookup = {};
var nextRgbIndex = 256;

// Export functions to register and use 24-bit colors
colors.registerRgb = function(r, g, b) {
  var key = r + ',' + g + ',' + b;
  // Check if already registered
  for (var idx in rgbLookup) {
    if (rgbLookup[idx].key === key) return +idx;
  }
  // Register new color
  if (nextRgbIndex > 510) nextRgbIndex = 256;
  var index = nextRgbIndex++;
  rgbLookup[index] = { r: r, g: g, b: b, key: key };
  return index;
};

colors.getRgb = function(index) {
  return rgbLookup[index] || null;
};`;

content = content.replace(boxRequire, rgbLookupCode);

// Patch 2: Modify output code to emit 24-bit codes for indices >= 256
// Background color output
content = content.replace(
  /(\s+)out \+= '48;5;' \+ bg \+ ';';/g,
  `$1if (bg >= 256) {
$1  var rgbBg = colors.getRgb(bg);
$1  if (rgbBg) out += '48;2;' + rgbBg.r + ';' + rgbBg.g + ';' + rgbBg.b + ';';
$1  else out += '48;5;' + bg + ';';
$1} else {
$1  out += '48;5;' + bg + ';';
$1}`
);

// Foreground color output
content = content.replace(
  /(\s+)out \+= '38;5;' \+ fg \+ ';';/g,
  `$1if (fg >= 256) {
$1  var rgbFg = colors.getRgb(fg);
$1  if (rgbFg) out += '38;2;' + rgbFg.r + ';' + rgbFg.g + ';' + rgbFg.b + ';';
$1  else out += '38;5;' + fg + ';';
$1} else {
$1  out += '38;5;' + fg + ';';
$1}`
);

// Patch 3: Modify input parsing to register RGB instead of converting
// Background RGB parsing
content = content.replace(
  /bg = colors\.match\(\+code\[i\], \+code\[i\+1\], \+code\[i\+2\]\);\s*\n\s*if \(bg === -1\) bg = def & 0x1ff;/,
  'bg = colors.registerRgb(+code[i], +code[i+1], +code[i+2]);'
);

// Foreground RGB parsing
content = content.replace(
  /fg = colors\.match\(\+code\[i\], \+code\[i\+1\], \+code\[i\+2\]\);\s*\n\s*if \(fg === -1\) fg = \(def >> 9\) & 0x1ff;/,
  'fg = colors.registerRgb(+code[i], +code[i+1], +code[i+2]);'
);

fs.writeFileSync(screenPath, content);
console.log('neo-blessed patched for 24-bit RGB color support');
