#!/usr/bin/env bun
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const METRICS_DIR = join(ROOT, 'metrics');

interface ESLintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

interface ESLintFileResult {
  filePath: string;
  messages: ESLintMessage[];
  errorCount: number;
  warningCount: number;
}

interface ComplexityEntry {
  value: number;
  fn: string;
  file: string;
  line: number;
}

interface FileHotspot {
  file: string;
  lines: number;
  cyclomaticMax: number;
  cognitiveMax: number;
  smells: number;
}

interface MetricsSnapshot {
  timestamp: string;
  gitRef: string;
  gitSha: string;
  summary: {
    files: number;
    lines: number;
    functions: number;
    avgCyclomaticComplexity: number;
    maxCyclomaticComplexity: { value: number; function: string; file: string };
    avgCognitiveComplexity: number;
    maxCognitiveComplexity: { value: number; function: string; file: string };
    smells: number;
  };
  hotspots: FileHotspot[];
  smellsByRule: Record<string, number>;
}

// --- Helpers ---

async function getGitInfo(): Promise<{ ref: string; sha: string }> {
  const shaProc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT });
  const sha = (await new Response(shaProc.stdout).text()).trim();

  const tagProc = Bun.spawn(['git', 'describe', '--tags', '--exact-match', 'HEAD'], {
    cwd: ROOT,
    stderr: 'ignore',
  });
  const tag = (await new Response(tagProc.stdout).text()).trim();

  return { ref: tag || sha, sha };
}

async function countLines(filePath: string): Promise<number> {
  const content = await readFile(filePath, 'utf-8');
  return content.split('\n').length;
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      files.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function parseFunctionName(message: string): string {
  // ESLint complexity messages: "Function 'foo' has a complexity of 10."
  // or "Arrow function has a complexity of 5."
  const fnMatch = message.match(/(?:Function|Method) '([^']+)'/);
  if (fnMatch) return fnMatch[1];
  if (message.includes('arrow function')) return '(arrow)';
  return '(anonymous)';
}

function parseComplexityValue(message: string): number {
  // Standard: "...has a complexity of 10."
  // Sonarjs: "...Cognitive Complexity from 16 to the 15 allowed"
  const match = message.match(/complexity (?:of|from) (\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function parseLinesValue(message: string): number {
  // "...has too many lines (42). Maximum allowed is 1."
  const match = message.match(/has too many lines \((\d+)\)/);
  return match ? parseInt(match[1], 10) : 0;
}

// --- Main ---

async function main() {
  const saveFlag = process.argv.includes('--save');

  // Run ESLint with metrics config
  const eslintBin = join(ROOT, 'node_modules', '.bin', 'eslint');
  const proc = Bun.spawn([eslintBin, '--config', 'eslint.metrics.js', '--format', 'json', 'src/'], {
    cwd: ROOT,
    stderr: 'pipe',
  });
  const rawOutput = await new Response(proc.stdout).text();
  const stderrOutput = await new Response(proc.stderr).text();
  await proc.exited;

  // ESLint exits non-zero when there are warnings/errors, that's expected
  let eslintResults: ESLintFileResult[];
  try {
    eslintResults = JSON.parse(rawOutput);
  } catch {
    console.error('Failed to parse ESLint output.');
    if (stderrOutput) console.error(stderrOutput);
    process.exit(1);
  }

  // Collect source files and line counts
  const sourceFiles = await collectSourceFiles(SRC);
  const lineCounts = new Map<string, number>();
  await Promise.all(
    sourceFiles.map(async (f) => {
      lineCounts.set(f, await countLines(f));
    })
  );

  const totalLines = [...lineCounts.values()].reduce((a, b) => a + b, 0);
  const gitInfo = await getGitInfo();

  // Parse ESLint results
  const cyclomaticEntries: ComplexityEntry[] = [];
  const cognitiveEntries: ComplexityEntry[] = [];
  const smellsByRule: Record<string, number> = {};
  const fileSmells = new Map<string, number>();
  const fileCyclomaticMax = new Map<string, number>();
  const fileCognitiveMax = new Map<string, number>();
  let totalSmells = 0;
  let functionCount = 0;

  for (const fileResult of eslintResults) {
    const relPath = relative(ROOT, fileResult.filePath);

    for (const msg of fileResult.messages) {
      if (!msg.ruleId) continue;

      if (msg.ruleId === 'complexity') {
        const value = parseComplexityValue(msg.message);
        const fn = parseFunctionName(msg.message);
        cyclomaticEntries.push({ value, fn, file: relPath, line: msg.line });
        fileCyclomaticMax.set(relPath, Math.max(fileCyclomaticMax.get(relPath) ?? 0, value));
      } else if (msg.ruleId === 'sonarjs/cognitive-complexity') {
        const value = parseComplexityValue(msg.message);
        const fn = parseFunctionName(msg.message);
        cognitiveEntries.push({ value, fn, file: relPath, line: msg.line });
        fileCognitiveMax.set(relPath, Math.max(fileCognitiveMax.get(relPath) ?? 0, value));
      } else if (msg.ruleId === 'max-lines-per-function') {
        // This rule fires per function, use it to count functions
        functionCount++;
      } else {
        // Everything else is a smell
        totalSmells++;
        smellsByRule[msg.ruleId] = (smellsByRule[msg.ruleId] ?? 0) + 1;
        fileSmells.set(relPath, (fileSmells.get(relPath) ?? 0) + 1);
      }
    }
  }

  // If max-lines-per-function didn't fire for some functions (single-line ones),
  // at least use cyclomaticEntries as a lower bound for function count
  functionCount = Math.max(functionCount, cyclomaticEntries.length);

  // Sonarjs cognitive-complexity messages don't include function names.
  // Cross-reference with cyclomatic entries at the same file+line.
  const cyclomaticByLocation = new Map<string, string>();
  for (const e of cyclomaticEntries) {
    cyclomaticByLocation.set(`${e.file}:${e.line}`, e.fn);
  }
  for (const e of cognitiveEntries) {
    if (e.fn === '(anonymous)') {
      const name = cyclomaticByLocation.get(`${e.file}:${e.line}`);
      if (name) e.fn = name;
    }
  }

  const avgCyclomatic =
    cyclomaticEntries.length > 0
      ? cyclomaticEntries.reduce((sum, e) => sum + e.value, 0) / cyclomaticEntries.length
      : 0;

  const avgCognitive =
    cognitiveEntries.length > 0
      ? cognitiveEntries.reduce((sum, e) => sum + e.value, 0) / cognitiveEntries.length
      : 0;

  const maxCyclomatic = cyclomaticEntries.reduce((max, e) => (e.value > max.value ? e : max), {
    value: 0,
    fn: '',
    file: '',
    line: 0,
  });

  const maxCognitive = cognitiveEntries.reduce((max, e) => (e.value > max.value ? e : max), {
    value: 0,
    fn: '',
    file: '',
    line: 0,
  });

  // Build hotspots: files that have any smells or notable complexity
  const hotspotFiles = new Set<string>();
  for (const f of fileSmells.keys()) hotspotFiles.add(f);
  for (const f of fileCyclomaticMax.keys()) {
    if ((fileCyclomaticMax.get(f) ?? 0) > 10) hotspotFiles.add(f);
  }
  for (const f of fileCognitiveMax.keys()) {
    if ((fileCognitiveMax.get(f) ?? 0) > 10) hotspotFiles.add(f);
  }

  const hotspots: FileHotspot[] = [...hotspotFiles]
    .map((file) => {
      const absPath = join(ROOT, file);
      return {
        file,
        lines: lineCounts.get(absPath) ?? 0,
        cyclomaticMax: fileCyclomaticMax.get(file) ?? 0,
        cognitiveMax: fileCognitiveMax.get(file) ?? 0,
        smells: fileSmells.get(file) ?? 0,
      };
    })
    .sort((a, b) => b.smells - a.smells || b.cyclomaticMax - a.cyclomaticMax);

  const snapshot: MetricsSnapshot = {
    timestamp: new Date().toISOString(),
    gitRef: gitInfo.ref,
    gitSha: gitInfo.sha,
    summary: {
      files: sourceFiles.length,
      lines: totalLines,
      functions: functionCount,
      avgCyclomaticComplexity: Math.round(avgCyclomatic * 10) / 10,
      maxCyclomaticComplexity: {
        value: maxCyclomatic.value,
        function: maxCyclomatic.fn,
        file: `${maxCyclomatic.file}:${maxCyclomatic.line}`,
      },
      avgCognitiveComplexity: Math.round(avgCognitive * 10) / 10,
      maxCognitiveComplexity: {
        value: maxCognitive.value,
        function: maxCognitive.fn,
        file: `${maxCognitive.file}:${maxCognitive.line}`,
      },
      smells: totalSmells,
    },
    hotspots,
    smellsByRule,
  };

  // Print summary table
  const s = snapshot.summary;
  console.log('');
  console.log('=== Code Quality Metrics ===');
  console.log(`  Git ref:    ${snapshot.gitRef} (${snapshot.gitSha})`);
  console.log(`  Timestamp:  ${snapshot.timestamp}`);
  console.log('');
  console.log(`  Files:      ${s.files}`);
  console.log(`  Lines:      ${s.lines}`);
  console.log(`  Functions:  ${s.functions}`);
  console.log('');
  console.log(
    `  Cyclomatic complexity:  avg ${s.avgCyclomaticComplexity}  max ${s.maxCyclomaticComplexity.value} (${s.maxCyclomaticComplexity.function} in ${s.maxCyclomaticComplexity.file})`
  );
  console.log(
    `  Cognitive complexity:   avg ${s.avgCognitiveComplexity}  max ${s.maxCognitiveComplexity.value} (${s.maxCognitiveComplexity.function} in ${s.maxCognitiveComplexity.file})`
  );
  console.log(`  Code smells:            ${s.smells}`);

  if (Object.keys(smellsByRule).length > 0) {
    console.log('');
    console.log('  Smells by rule:');
    const sorted = Object.entries(smellsByRule).sort((a, b) => b[1] - a[1]);
    for (const [rule, count] of sorted) {
      console.log(`    ${rule}: ${count}`);
    }
  }

  if (hotspots.length > 0) {
    console.log('');
    console.log('  Hotspots:');
    console.log('    File                                     Lines  Cycl  Cogn  Smells');
    console.log('    ' + '-'.repeat(70));
    for (const h of hotspots.slice(0, 15)) {
      const name = h.file.length > 40 ? '...' + h.file.slice(-37) : h.file.padEnd(40);
      console.log(
        `    ${name} ${String(h.lines).padStart(5)}  ${String(h.cyclomaticMax).padStart(4)}  ${String(h.cognitiveMax).padStart(4)}  ${String(h.smells).padStart(6)}`
      );
    }
    if (hotspots.length > 15) {
      console.log(`    ... and ${hotspots.length - 15} more`);
    }
  }

  console.log('');

  // Save if requested
  if (saveFlag) {
    await mkdir(METRICS_DIR, { recursive: true });
    const filename = `${snapshot.gitRef.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    const outPath = join(METRICS_DIR, filename);
    await Bun.write(outPath, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`  Snapshot saved to: ${relative(ROOT, outPath)}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
