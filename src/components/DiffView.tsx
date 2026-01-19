import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { createEmphasize, common } from 'emphasize';
import fastDiff from 'fast-diff';
import { DiffResult, DiffLine } from '../git/diff.js';
import { Theme, getTheme, ThemeName } from '../themes.js';

// Create emphasize instance with common languages
const emphasize = createEmphasize(common);

interface DiffViewProps {
  diff: DiffResult | null;
  filePath?: string;
  maxHeight?: number;
  scrollOffset?: number;
  theme?: ThemeName;
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

// Segment with highlighting info for word-level diff
interface DiffSegment {
  text: string;
  isChange: boolean;
}

// Compute word-level diff between old and new line
function computeWordDiff(oldContent: string, newContent: string): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const diff = fastDiff(oldContent, newContent);

  const oldSegments: DiffSegment[] = [];
  const newSegments: DiffSegment[] = [];

  for (const [type, text] of diff) {
    if (type === fastDiff.EQUAL) {
      // Text exists in both - not a change
      oldSegments.push({ text, isChange: false });
      newSegments.push({ text, isChange: false });
    } else if (type === fastDiff.DELETE) {
      // Text only in old - it's a deletion (highlight it)
      oldSegments.push({ text, isChange: true });
    } else if (type === fastDiff.INSERT) {
      // Text only in new - it's an addition (highlight it)
      newSegments.push({ text, isChange: true });
    }
  }

  return { oldSegments, newSegments };
}

// Find paired modifications (deletion followed by addition)
interface LinePair {
  deletion: DiffLine;
  addition: DiffLine;
  deletionIndex: number;
  additionIndex: number;
}

function findModificationPairs(lines: DiffLine[]): Map<number, LinePair> {
  const pairs = new Map<number, LinePair>();

  for (let i = 0; i < lines.length - 1; i++) {
    const current = lines[i];
    const next = lines[i + 1];

    // Look for deletion followed by addition (single-line modification)
    if (current.type === 'deletion' && next.type === 'addition') {
      const pair = { deletion: current, addition: next, deletionIndex: i, additionIndex: i + 1 };
      pairs.set(i, pair);
      pairs.set(i + 1, pair);
    }
  }

  return pairs;
}

// Render content with word-level highlighting (Claude Code style)
function WordDiffContent({
  segments,
  isAddition,
  theme,
}: {
  segments: DiffSegment[];
  isAddition: boolean;
  theme: Theme;
}): React.ReactElement {
  const { colors } = theme;
  const baseBg = isAddition ? colors.addBg : colors.delBg;
  const highlightBg = isAddition ? colors.addHighlight : colors.delHighlight;

  return (
    <>
      {segments.map((segment, i) => (
        <Text
          key={i}
          color={colors.text}
          backgroundColor={segment.isChange ? highlightBg : baseBg}
        >
          {segment.text || (i === segments.length - 1 ? ' ' : '')}
        </Text>
      ))}
    </>
  );
}

function DiffLineComponent({
  line,
  lineNumWidth,
  language,
  wordDiffSegments,
  theme,
}: {
  line: DiffLine;
  lineNumWidth: number;
  language?: string;
  wordDiffSegments?: DiffSegment[];
  theme: Theme;
}): React.ReactElement {
  const { colors } = theme;

  // Headers - show dimmed
  if (line.type === 'header') {
    return (
      <Box>
        <Text dimColor>{line.content}</Text>
      </Box>
    );
  }

  // Hunk headers - show with blue styling (like @@ -1,5 +1,7 @@)
  if (line.type === 'hunk') {
    const match = line.content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (match) {
      const context = match[3].trim();
      return (
        <Box>
          <Text color="cyan" dimColor>{line.content.slice(0, line.content.indexOf('@@', 3) + 2)}</Text>
          {context && <Text color="gray"> {context}</Text>}
        </Box>
      );
    }
    return <Text color="cyan" dimColor>{line.content}</Text>;
  }

  // Get line number to display (use new for additions, old for deletions, either for context)
  const lineNum = line.type === 'addition'
    ? line.newLineNum
    : line.type === 'deletion'
      ? line.oldLineNum
      : (line.oldLineNum ?? line.newLineNum);

  const lineNumStr = lineNum !== undefined
    ? String(lineNum).padStart(lineNumWidth, ' ')
    : ' '.repeat(lineNumWidth);

  // Content without the leading +/-/space
  const content = getLineContent(line);

  if (line.type === 'addition') {
    return (
      <Box>
        <Text backgroundColor={colors.addBg} color={colors.addLineNum}>{lineNumStr} </Text>
        <Text backgroundColor={colors.addBg} color={colors.addSymbol} bold>+ </Text>
        {wordDiffSegments ? (
          <WordDiffContent segments={wordDiffSegments} isAddition={true} theme={theme} />
        ) : (
          <Text backgroundColor={colors.addBg} color={colors.text}>{content || ' '}</Text>
        )}
      </Box>
    );
  }

  if (line.type === 'deletion') {
    return (
      <Box>
        <Text backgroundColor={colors.delBg} color={colors.delLineNum}>{lineNumStr} </Text>
        <Text backgroundColor={colors.delBg} color={colors.delSymbol} bold>- </Text>
        {wordDiffSegments ? (
          <WordDiffContent segments={wordDiffSegments} isAddition={false} theme={theme} />
        ) : (
          <Text backgroundColor={colors.delBg} color={colors.text}>{content || ' '}</Text>
        )}
      </Box>
    );
  }

  // Context line - no background, just syntax highlighting
  const highlighted = highlightLine(content, language);
  return (
    <Box>
      <Text color={colors.contextLineNum}>{lineNumStr}   </Text>
      <Text>{highlighted}</Text>
    </Box>
  );
}

export function DiffView({ diff, filePath, maxHeight = 20, scrollOffset = 0, theme: themeName = 'dark' }: DiffViewProps): React.ReactElement {
  // Memoize theme and language detection
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  // Memoize modification pairs and word diffs
  const wordDiffs = useMemo(() => {
    if (!diff) return new Map<number, DiffSegment[]>();

    const pairs = findModificationPairs(diff.lines);
    const diffs = new Map<number, DiffSegment[]>();

    // Compute word diffs for paired lines
    for (const [index, pair] of pairs) {
      if (index === pair.deletionIndex) {
        const oldContent = getLineContent(pair.deletion);
        const newContent = getLineContent(pair.addition);
        const { oldSegments, newSegments } = computeWordDiff(oldContent, newContent);
        diffs.set(pair.deletionIndex, oldSegments);
        diffs.set(pair.additionIndex, newSegments);
      }
    }

    return diffs;
  }, [diff]);

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

      {visibleLines.map((line, i) => {
        const actualIndex = scrollOffset + i;
        const wordDiffSegments = wordDiffs.get(actualIndex);

        return (
          <DiffLineComponent
            key={`${actualIndex}-${line.content.slice(0, 20)}`}
            line={line}
            lineNumWidth={lineNumWidth}
            language={language}
            wordDiffSegments={wordDiffSegments}
            theme={theme}
          />
        );
      })}

      {hasMore && (
        <Text dimColor>↓ {diff.lines.length - scrollOffset - maxHeight} more lines below</Text>
      )}
    </Box>
  );
}
