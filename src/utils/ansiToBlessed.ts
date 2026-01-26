/**
 * Convert ANSI escape codes to blessed tags.
 * Supports basic foreground colors and styles.
 */

// ANSI color code to blessed color name mapping
const ANSI_FG_COLORS: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'gray',
  91: 'red',
  92: 'green',
  93: 'yellow',
  94: 'blue',
  95: 'magenta',
  96: 'cyan',
  97: 'white',
};

/**
 * Escape blessed tags in plain text.
 */
function escapeBlessed(text: string): string {
  return text.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/**
 * Convert ANSI escape sequences to blessed tags.
 *
 * @param input - String containing ANSI escape codes
 * @returns String with blessed tags
 */
export function ansiToBlessed(input: string): string {
  if (!input) return '';

  // Track current styles
  const activeStyles: string[] = [];
  let result = '';
  let i = 0;

  while (i < input.length) {
    // Check for ANSI escape sequence
    if (input[i] === '\x1b' && input[i + 1] === '[') {
      // Find the end of the sequence (look for 'm')
      let j = i + 2;
      while (j < input.length && input[j] !== 'm') {
        j++;
      }

      if (input[j] === 'm') {
        // Parse the codes
        const codes = input
          .slice(i + 2, j)
          .split(';')
          .map(Number);

        for (const code of codes) {
          if (code === 0) {
            // Reset - close all active styles
            while (activeStyles.length > 0) {
              const style = activeStyles.pop();
              if (style) {
                result += `{/${style}}`;
              }
            }
          } else if (code === 1) {
            // Bold
            activeStyles.push('bold');
            result += '{bold}';
          } else if (code === 2) {
            // Dim/faint - blessed doesn't have direct support, use gray
            activeStyles.push('gray-fg');
            result += '{gray-fg}';
          } else if (code === 3) {
            // Italic - not well supported in terminals, skip
          } else if (code === 4) {
            // Underline
            activeStyles.push('underline');
            result += '{underline}';
          } else if (code >= 30 && code <= 37) {
            // Standard foreground colors
            const color = ANSI_FG_COLORS[code];
            if (color) {
              activeStyles.push(`${color}-fg`);
              result += `{${color}-fg}`;
            }
          } else if (code >= 90 && code <= 97) {
            // Bright foreground colors
            const color = ANSI_FG_COLORS[code];
            if (color) {
              activeStyles.push(`${color}-fg`);
              result += `{${color}-fg}`;
            }
          }
          // Note: We ignore background colors (40-47, 100-107) for simplicity
        }

        i = j + 1;
        continue;
      }
    }

    // Regular character - escape if needed and append
    const char = input[i];
    if (char === '{' || char === '}') {
      result += char + char;
    } else {
      result += char;
    }
    i++;
  }

  // Close any remaining active styles
  while (activeStyles.length > 0) {
    const style = activeStyles.pop();
    if (style) {
      result += `{/${style}}`;
    }
  }

  return result;
}
