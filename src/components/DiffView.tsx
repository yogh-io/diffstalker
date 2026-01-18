import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { createEmphasize, common } from 'emphasize';
import { DiffResult, DiffLine } from '../git/diff.js';

// Create emphasize instance with common languages
const emphasize = createEmphasize(common);

interface DiffViewProps {
  diff: DiffResult | null;
  filePath?: string;
  maxHeight?: number;
  scrollOffset?: number;
}

// Map common file extensions to highlight.js language names
const LANG_MAP: Record<string, string> = {
  'ts': 'typescript',
  'tsx': 'typescript',
  'js': 'javascript',
  'jsx': 'javascript',
  'mjs': 'javascript',
  'cjs': 'javascript',
  'py': 'python',
  'rb': 'ruby',
  'rs': 'rust',
  'go': 'go',
  'java': 'java',
  'c': 'c',
  'cpp': 'cpp',
  'h': 'c',
  'hpp': 'cpp',
  'cs': 'csharp',
  'php': 'php',
  'sh': 'bash',
  'bash': 'bash',
  'zsh': 'bash',
  'json': 'json',
  'yaml': 'yaml',
  'yml': 'yaml',
  'md': 'markdown',
  'html': 'html',
  'htm': 'html',
  'css': 'css',
  'scss': 'scss',
  'sass': 'scss',
  'less': 'less',
  'sql': 'sql',
  'xml': 'xml',
  'toml': 'ini',
  'ini': 'ini',
  'dockerfile': 'dockerfile',
  'makefile': 'makefile',
  'lua': 'lua',
  'vim': 'vim',
  'swift': 'swift',
  'kt': 'kotlin',
  'kts': 'kotlin',
  'scala': 'scala',
  'r': 'r',
  'pl': 'perl',
  'ex': 'elixir',
  'exs': 'elixir',
  'erl': 'erlang',
  'hs': 'haskell',
  'clj': 'clojure',
  'ml': 'ocaml',
  'fs': 'fsharp',
  'vue': 'xml',
  'svelte': 'xml',
};

// Get language from file path
function getLanguageFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;

  // Handle special filenames
  const filename = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (filename === 'dockerfile') return 'dockerfile';
  if (filename === 'makefile' || filename === 'gnumakefile') return 'makefile';

  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? (LANG_MAP[ext] || ext) : undefined;
}

// Highlight a single line of code
function highlightLine(content: string, language?: string): string {
  if (!language || !content.trim()) return content;
  try {
    return emphasize.highlight(language, content).value;
  } catch {
    return content;  // Fallback if highlighting fails
  }
}

// Calculate max line number width for consistent column sizing
function getLineNumWidth(lines: DiffLine[]): number {
  let maxLineNum = 0;
  for (const line of lines) {
    if (line.oldLineNum && line.oldLineNum > maxLineNum) maxLineNum = line.oldLineNum;
    if (line.newLineNum && line.newLineNum > maxLineNum) maxLineNum = line.newLineNum;
  }
  return Math.max(3, String(maxLineNum).length);
}

// Get the actual content without the diff symbol (+/-)
function getLineContent(line: DiffLine): string {
  if (line.type === 'addition' || line.type === 'deletion') {
    return line.content.slice(1);  // Remove the leading + or -
  }
  if (line.type === 'context' && line.content.startsWith(' ')) {
    return line.content.slice(1);  // Remove the leading space
  }
  return line.content;
}

function DiffLineComponent({ line, lineNumWidth, language }: { line: DiffLine; lineNumWidth: number; language?: string }): React.ReactElement {
  // Headers - show dimmed
  if (line.type === 'header') {
    return (
      <Box>
        <Text dimColor>{line.content}</Text>
      </Box>
    );
  }

  // Hunk headers - show with blue styling
  if (line.type === 'hunk') {
    const match = line.content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (match) {
      const context = match[3].trim();
      return (
        <Box>
          <Text backgroundColor="blue" color="white">
            {' '.repeat(lineNumWidth * 2 + 3)}
          </Text>
          <Text color="blue"> {context || '...'}</Text>
        </Box>
      );
    }
    return <Text color="cyan">{line.content}</Text>;
  }

  // Content lines (addition, deletion, context)
  const content = getLineContent(line);
  const highlighted = highlightLine(content, language);
  const oldNum = line.oldLineNum !== undefined ? String(line.oldLineNum).padStart(lineNumWidth, ' ') : ' '.repeat(lineNumWidth);
  const newNum = line.newLineNum !== undefined ? String(line.newLineNum).padStart(lineNumWidth, ' ') : ' '.repeat(lineNumWidth);

  if (line.type === 'addition') {
    return (
      <Box>
        <Text dimColor>{' '.repeat(lineNumWidth)}</Text>
        <Text color="green" bold> {newNum} + </Text>
        <Text backgroundColor="greenBright">{highlighted || ' '}</Text>
      </Box>
    );
  }

  if (line.type === 'deletion') {
    return (
      <Box>
        <Text color="red" bold>{oldNum} </Text>
        <Text dimColor>{' '.repeat(lineNumWidth)}</Text>
        <Text color="red" bold> - </Text>
        <Text backgroundColor="redBright">{highlighted || ' '}</Text>
      </Box>
    );
  }

  // Context line
  return (
    <Box>
      <Text dimColor>{oldNum} {newNum}   </Text>
      <Text>{highlighted}</Text>
    </Box>
  );
}

export function DiffView({ diff, filePath, maxHeight = 20, scrollOffset = 0 }: DiffViewProps): React.ReactElement {
  // Memoize language detection
  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  if (!diff || diff.lines.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No diff to display</Text>
      </Box>
    );
  }

  // Calculate line number width for consistent column sizing
  const lineNumWidth = getLineNumWidth(diff.lines);

  // Apply scroll offset and limit
  const visibleLines = diff.lines.slice(scrollOffset, scrollOffset + maxHeight);
  const hasMore = diff.lines.length > scrollOffset + maxHeight;
  const hasPrevious = scrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {hasPrevious && (
        <Text dimColor>↑ {scrollOffset} more lines above</Text>
      )}

      {visibleLines.map((line, i) => (
        <DiffLineComponent
          key={`${scrollOffset + i}-${line.content.slice(0, 20)}`}
          line={line}
          lineNumWidth={lineNumWidth}
          language={language}
        />
      ))}

      {hasMore && (
        <Text dimColor>↓ {diff.lines.length - scrollOffset - maxHeight} more lines below</Text>
      )}
    </Box>
  );
}
