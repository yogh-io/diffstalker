import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { createEmphasize, common } from 'emphasize';
import fastDiff from 'fast-diff';
import { DiffResult, DiffLine } from '../git/diff.js';
import { Theme, getTheme, ThemeName } from '../themes.js';
import { ScrollableList } from './ScrollableList.js';
import { isDisplayableDiffLine } from '../utils/diffFilters.js';

// Create emphasize instance with common languages
const emphasize = createEmphasize(common);

// Truncate string to fit within maxWidth
function truncateString(str: string, maxWidth: number): string {
  if (maxWidth <= 0 || str.length <= maxWidth) return str;
  if (maxWidth <= 1) return '…';
  return str.slice(0, maxWidth - 1) + '…';
}

interface DiffViewProps {
  diff: DiffResult | null;
  filePath?: string;
  maxHeight?: number;
  scrollOffset?: number;
  theme?: ThemeName;
  width?: number;
}

// Map common file extensions to highlight.js language names
const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  sql: 'sql',
  xml: 'xml',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  vim: 'vim',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  r: 'r',
  pl: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  ml: 'ocaml',
  fs: 'fsharp',
  vue: 'xml',
  svelte: 'xml',
};

// Get language from file path
function getLanguageFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;

  // Handle special filenames
  const filename = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (filename === 'dockerfile') return 'dockerfile';
  if (filename === 'makefile' || filename === 'gnumakefile') return 'makefile';

  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? LANG_MAP[ext] || ext : undefined;
}

// Highlight a single line of code
function highlightLine(content: string, language?: string): string {
  if (!language || !content.trim()) return content;
  try {
    return emphasize.highlight(language, content).value;
  } catch {
    return content; // Fallback if highlighting fails
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
    return line.content.slice(1); // Remove the leading + or -
  }
  if (line.type === 'context' && line.content.startsWith(' ')) {
    return line.content.slice(1); // Remove the leading space
  }
  return line.content;
}

// Segment with highlighting info for word-level diff
interface DiffSegment {
  text: string;
  isChange: boolean;
}

// Minimum unchanged segment length to keep as unchanged (shorter gets merged into changes)
const MIN_UNCHANGED_LENGTH = 3;

// Merge tiny unchanged segments into surrounding changes
function mergeSmallSegments(segments: DiffSegment[]): DiffSegment[] {
  if (segments.length === 0) return segments;

  const result: DiffSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // If unchanged segment is too short and surrounded by changes, mark as changed
    if (!segment.isChange && segment.text.length < MIN_UNCHANGED_LENGTH) {
      const prevIsChange = i > 0 && result[result.length - 1]?.isChange;
      const nextIsChange = i < segments.length - 1 && segments[i + 1]?.isChange;

      if (prevIsChange || nextIsChange) {
        // Merge into previous change segment if possible, otherwise mark as change
        if (prevIsChange && result.length > 0) {
          result[result.length - 1].text += segment.text;
        } else {
          result.push({ text: segment.text, isChange: true });
        }
        continue;
      }
    }

    // Merge consecutive segments of same type
    if (result.length > 0 && result[result.length - 1].isChange === segment.isChange) {
      result[result.length - 1].text += segment.text;
    } else {
      result.push({ ...segment });
    }
  }

  return result;
}

// Compute word-level diff between old and new line
function computeWordDiff(
  oldContent: string,
  newContent: string
): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const diff = fastDiff(oldContent, newContent);

  let oldSegments: DiffSegment[] = [];
  let newSegments: DiffSegment[] = [];

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

  // Merge tiny unchanged segments to avoid fragmented highlighting
  oldSegments = mergeSmallSegments(oldSegments);
  newSegments = mergeSmallSegments(newSegments);

  return { oldSegments, newSegments };
}

// Calculate similarity ratio between two strings (0 to 1)
function calculateSimilarity(oldStr: string, newStr: string): number {
  if (oldStr.length === 0 && newStr.length === 0) return 1;
  if (oldStr.length === 0 || newStr.length === 0) return 0;

  const diff = fastDiff(oldStr, newStr);
  let unchanged = 0;
  let total = 0;

  for (const [type, text] of diff) {
    if (type === fastDiff.EQUAL) {
      unchanged += text.length;
      total += text.length;
    } else {
      total += text.length;
    }
  }

  return total > 0 ? unchanged / total : 0;
}

// Minimum similarity ratio to show word-level diff (below this, lines are too different)
const SIMILARITY_THRESHOLD = 0.35;

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
      const oldContent = getLineContent(current);
      const newContent = getLineContent(next);

      // Only pair if lines are similar enough for meaningful word-level diff
      if (calculateSimilarity(oldContent, newContent) >= SIMILARITY_THRESHOLD) {
        const pair = { deletion: current, addition: next, deletionIndex: i, additionIndex: i + 1 };
        pairs.set(i, pair);
        pairs.set(i + 1, pair);
      }
    }
  }

  return pairs;
}

// Truncate segments to fit within maxWidth
function truncateSegments(segments: DiffSegment[], maxWidth: number): DiffSegment[] {
  const result: DiffSegment[] = [];
  let remaining = maxWidth;

  for (const segment of segments) {
    if (remaining <= 0) break;

    if (segment.text.length <= remaining) {
      result.push(segment);
      remaining -= segment.text.length;
    } else {
      // Truncate this segment and add ellipsis
      const truncatedText = segment.text.slice(0, remaining - 1) + '…';
      result.push({ ...segment, text: truncatedText });
      break;
    }
  }

  return result;
}

// Render content with word-level highlighting (Claude Code style)
function WordDiffContent({
  segments,
  isAddition,
  theme,
  maxWidth,
}: {
  segments: DiffSegment[];
  isAddition: boolean;
  theme: Theme;
  maxWidth?: number;
}): React.ReactElement {
  const { colors } = theme;
  const baseBg = isAddition ? colors.addBg : colors.delBg;
  const highlightBg = isAddition ? colors.addHighlight : colors.delHighlight;

  // Truncate segments if needed
  const displaySegments = maxWidth ? truncateSegments(segments, maxWidth) : segments;

  // Wrap in parent Text to ensure inline rendering
  return (
    <Text backgroundColor={baseBg}>
      {displaySegments.map((segment, i) => (
        <Text key={i} color={colors.text} backgroundColor={segment.isChange ? highlightBg : baseBg}>
          {segment.text || (i === displaySegments.length - 1 ? ' ' : '')}
        </Text>
      ))}
    </Text>
  );
}

function DiffLineComponent({
  line,
  lineNumWidth,
  language,
  wordDiffSegments,
  theme,
  maxWidth,
}: {
  line: DiffLine;
  lineNumWidth: number;
  language?: string;
  wordDiffSegments?: DiffSegment[];
  theme: Theme;
  maxWidth?: number;
}): React.ReactElement {
  const { colors } = theme;

  // Calculate available width for headers (account for paddingX=1 on each side)
  const headerWidth = maxWidth ? maxWidth - 2 : undefined;

  // Headers - simplify verbose lines (redundant headers pre-filtered in displayableLines)
  if (line.type === 'header') {
    const content = line.content;
    // Extract file path from diff --git and show as clean separator
    if (content.startsWith('diff --git')) {
      const match = content.match(/diff --git a\/.+ b\/(.+)$/);
      if (match) {
        // Format: "── filename ──" - subtract 6 for the dashes and spaces
        const maxPathLen = headerWidth ? headerWidth - 6 : undefined;
        const path = maxPathLen ? truncateString(match[1], maxPathLen) : match[1];
        return (
          <Box>
            <Text color="cyan" bold>
              ── {path} ──
            </Text>
          </Box>
        );
      }
    }
    // Keep useful headers (new/deleted file, binary, rename info)
    const truncatedContent = headerWidth ? truncateString(content, headerWidth) : content;
    return (
      <Box>
        <Text dimColor>{truncatedContent}</Text>
      </Box>
    );
  }

  // Hunk headers - show as readable line ranges
  if (line.type === 'hunk') {
    const match = line.content.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (match) {
      const oldStart = parseInt(match[1], 10);
      const oldCount = match[2] ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newCount = match[4] ? parseInt(match[4], 10) : 1;
      const context = match[5].trim();

      const oldEnd = oldStart + oldCount - 1;
      const newEnd = newStart + newCount - 1;

      // Format as "Lines X-Y → X-Y" or "Line X → X" for single lines
      const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart}-${oldEnd}`;
      const newRange = newCount === 1 ? `${newStart}` : `${newStart}-${newEnd}`;

      // Calculate how much space is left for context
      const rangeText = `Lines ${oldRange} → ${newRange}`;
      const contextMaxLen = headerWidth ? headerWidth - rangeText.length - 1 : undefined;
      const truncatedContext =
        context && contextMaxLen && contextMaxLen > 3 ? truncateString(context, contextMaxLen) : '';

      return (
        <Box>
          <Text color="cyan" dimColor>
            {rangeText}
          </Text>
          {truncatedContext && <Text color="gray"> {truncatedContext}</Text>}
        </Box>
      );
    }
    const truncatedHunk = headerWidth ? truncateString(line.content, headerWidth) : line.content;
    return (
      <Text color="cyan" dimColor>
        {truncatedHunk}
      </Text>
    );
  }

  // Get line number to display (use new for additions, old for deletions, either for context)
  const lineNum =
    line.type === 'addition'
      ? line.newLineNum
      : line.type === 'deletion'
        ? line.oldLineNum
        : (line.oldLineNum ?? line.newLineNum);

  const lineNumStr =
    lineNum !== undefined ? String(lineNum).padStart(lineNumWidth, ' ') : ' '.repeat(lineNumWidth);

  // Content without the leading +/-/space
  const rawContent = getLineContent(line);

  // Calculate available width for content (subtract line num, space, symbol, paddingX)
  // Format: "  123 + content" = lineNumWidth + 1 (space) + 2 (symbol + space) + 2 (paddingX)
  const contentWidth = maxWidth ? maxWidth - lineNumWidth - 5 : undefined;
  const content = contentWidth ? truncateString(rawContent, contentWidth) : rawContent;

  if (line.type === 'addition') {
    return (
      <Box>
        <Text backgroundColor={colors.addBg} color={colors.addLineNum}>
          {lineNumStr}{' '}
        </Text>
        <Text backgroundColor={colors.addBg} color={colors.addSymbol} bold>
          +{' '}
        </Text>
        {wordDiffSegments ? (
          <WordDiffContent
            segments={wordDiffSegments}
            isAddition={true}
            theme={theme}
            maxWidth={contentWidth}
          />
        ) : (
          <Text backgroundColor={colors.addBg} color={colors.text}>
            {content || ' '}
          </Text>
        )}
      </Box>
    );
  }

  if (line.type === 'deletion') {
    return (
      <Box>
        <Text backgroundColor={colors.delBg} color={colors.delLineNum}>
          {lineNumStr}{' '}
        </Text>
        <Text backgroundColor={colors.delBg} color={colors.delSymbol} bold>
          -{' '}
        </Text>
        {wordDiffSegments ? (
          <WordDiffContent
            segments={wordDiffSegments}
            isAddition={false}
            theme={theme}
            maxWidth={contentWidth}
          />
        ) : (
          <Text backgroundColor={colors.delBg} color={colors.text}>
            {content || ' '}
          </Text>
        )}
      </Box>
    );
  }

  // Context line - no background, just syntax highlighting
  const highlighted = highlightLine(content, language);
  return (
    <Box>
      <Text color={colors.contextLineNum}>{lineNumStr} </Text>
      <Text>{highlighted}</Text>
    </Box>
  );
}

export function DiffView({
  diff,
  filePath,
  maxHeight = 20,
  scrollOffset = 0,
  theme: themeName = 'dark',
  width,
}: DiffViewProps): React.ReactElement {
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

  // Filter out lines that will render as empty (skipped headers)
  // Keep original index for word diff lookup
  const displayableLines = useMemo(() => {
    return (
      diff?.lines
        .map((line, originalIndex) => ({ line, originalIndex }))
        .filter(({ line }) => isDisplayableDiffLine(line)) ?? []
    );
  }, [diff]);

  if (!diff || displayableLines.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No diff to display</Text>
      </Box>
    );
  }

  // Calculate line number width for consistent column sizing
  const lineNumWidth = getLineNumWidth(displayableLines.map((d) => d.line));

  return (
    <Box flexDirection="column" paddingX={1} overflowX="hidden">
      <ScrollableList
        items={displayableLines}
        maxHeight={maxHeight}
        scrollOffset={scrollOffset}
        getKey={(item) => `${item.originalIndex}`}
        renderItem={(item) => {
          const wordDiffSegments = wordDiffs.get(item.originalIndex);
          return (
            <DiffLineComponent
              line={item.line}
              lineNumWidth={lineNumWidth}
              language={language}
              wordDiffSegments={wordDiffSegments}
              theme={theme}
              maxWidth={width}
            />
          );
        }}
      />
    </Box>
  );
}
