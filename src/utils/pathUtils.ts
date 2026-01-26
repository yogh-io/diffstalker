import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Expand tilde (~) to home directory.
 */
export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === '~') {
    return os.homedir();
  }
  return p;
}

/**
 * Get the last non-empty line from content.
 * Supports append-only files by reading only the last non-empty line.
 */
export function getLastNonEmptyLine(content: string): string {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
}
