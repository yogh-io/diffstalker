import { execSync, spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';

export interface DiffLine {
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context';
  content: string;
}

export interface DiffResult {
  raw: string;
  lines: DiffLine[];
}

function parseDiffLine(line: string): DiffLine {
  if (line.startsWith('diff --git') || line.startsWith('index ') ||
      line.startsWith('---') || line.startsWith('+++') ||
      line.startsWith('new file') || line.startsWith('deleted file')) {
    return { type: 'header', content: line };
  }
  if (line.startsWith('@@')) {
    return { type: 'hunk', content: line };
  }
  if (line.startsWith('+')) {
    return { type: 'addition', content: line };
  }
  if (line.startsWith('-')) {
    return { type: 'deletion', content: line };
  }
  return { type: 'context', content: line };
}

export async function getDiff(
  repoPath: string,
  file?: string,
  staged: boolean = false
): Promise<DiffResult> {
  const git = simpleGit(repoPath);

  try {
    const args: string[] = [];
    if (staged) {
      args.push('--cached');
    }
    if (file) {
      args.push('--', file);
    }

    const raw = await git.diff(args);
    const lines = raw.split('\n').map(parseDiffLine);

    return { raw, lines };
  } catch (error) {
    return { raw: '', lines: [] };
  }
}

export async function getDiffForUntracked(repoPath: string, file: string): Promise<DiffResult> {
  try {
    // For untracked files, show the entire file as additions
    const content = execSync(`cat "${file}"`, { cwd: repoPath, encoding: 'utf-8' });
    const lines: DiffLine[] = [
      { type: 'header', content: `diff --git a/${file} b/${file}` },
      { type: 'header', content: 'new file mode 100644' },
      { type: 'header', content: `--- /dev/null` },
      { type: 'header', content: `+++ b/${file}` },
    ];

    const contentLines = content.split('\n');
    lines.push({ type: 'hunk', content: `@@ -0,0 +1,${contentLines.length} @@` });

    for (const line of contentLines) {
      lines.push({ type: 'addition', content: '+' + line });
    }

    const raw = lines.map(l => l.content).join('\n');
    return { raw, lines };
  } catch {
    return { raw: '', lines: [] };
  }
}

export async function getStagedDiff(repoPath: string): Promise<DiffResult> {
  return getDiff(repoPath, undefined, true);
}

export function spawnPager(pager: string, diff: string): void {
  const [cmd, ...args] = pager.split(' ');
  const proc = spawn(cmd, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  proc.stdin.write(diff);
  proc.stdin.end();
}
