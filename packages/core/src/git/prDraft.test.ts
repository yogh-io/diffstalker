import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DraftBranchError,
  DraftConflictError,
  DraftFileError,
  adoptSuggestion,
  checkDraftBranch,
  draftChangeOfEntry,
  draftsRoot,
  listDrafts,
  readDraft,
  resolveDraftDir,
  writeDraftTop,
} from './prDraft.js';
import { DRAFT_VERSION_ABSENT, MAX_DRAFT_BYTES } from '../types/work.js';

let commonDir: string;
let outside: string;

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function draftFile(branch: string, name: string): string {
  return path.join(draftsRoot(commonDir), ...branch.split('/'), name);
}

function put(branch: string, name: string, text: string): void {
  fs.mkdirSync(path.dirname(draftFile(branch, name)), { recursive: true });
  fs.writeFileSync(draftFile(branch, name), text);
}

/** Every path under a directory, relative, sorted. */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

beforeEach(() => {
  commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prdraft-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-prdraft-outside-'));
});

afterEach(() => {
  fs.rmSync(commonDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('checkDraftBranch', () => {
  it('accepts ordinary and nested names', () => {
    for (const name of ['main', 'feature/x', 'AER-1234-fix', 'a/b/c', 'v1.2', 'x.locked']) {
      expect(checkDraftBranch(name)).toBeNull();
    }
  });

  it('refuses every unsafe shape', () => {
    for (const name of [
      '',
      'x'.repeat(256),
      '-x',
      '--help',
      'a\0b',
      'a\nb',
      'a\x7fb',
      'a\\b',
      '/abs',
      'a/',
      'a//b',
      '.',
      '..',
      '../../hooks/x',
      'a/../b',
      '.hidden/x',
      'a/.b',
      'x.lock/y',
      'y/x.lock',
      'top.md',
      'feature/top.md',
      'feature/TOP.MD',
      'ai.md/x',
      'a/top.suggested.md/b',
      'adopted',
    ]) {
      expect(checkDraftBranch(name), JSON.stringify(name)).not.toBeNull();
    }
  });
});

describe('resolveDraftDir', () => {
  it('nests a branch with a slash', async () => {
    expect(await resolveDraftDir(commonDir, 'feature/x')).toBe(
      path.join(commonDir, 'diffstalker', 'pr', 'feature', 'x')
    );
  });

  it('refuses a refused name', async () => {
    await expect(resolveDraftDir(commonDir, '../../hooks/x')).rejects.toBeInstanceOf(
      DraftBranchError
    );
  });

  it('refuses a branch directory that is a link out', async () => {
    fs.mkdirSync(draftsRoot(commonDir), { recursive: true });
    fs.symlinkSync(outside, path.join(draftsRoot(commonDir), 'feature'));
    await expect(resolveDraftDir(commonDir, 'feature')).rejects.toBeInstanceOf(DraftBranchError);
    await expect(resolveDraftDir(commonDir, 'feature/x')).rejects.toBeInstanceOf(DraftBranchError);
    await expect(readDraft(commonDir, 'feature/x')).rejects.toBeInstanceOf(DraftBranchError);
    await expect(
      writeDraftTop(commonDir, 'feature/x', 'text', DRAFT_VERSION_ABSENT)
    ).rejects.toBeInstanceOf(DraftBranchError);
    expect(tree(outside)).toEqual([]);
  });

  for (const linked of [['diffstalker'], ['diffstalker', 'pr']]) {
    it(`refuses a linked ${linked.join('/')} for read, write and list`, async () => {
      const link = path.join(commonDir, ...linked);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.mkdirSync(path.join(outside, 'pr', 'seen'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'pr', 'seen', 'top.md'), 'outside');
      fs.symlinkSync(linked.length === 1 ? outside : path.join(outside, 'pr'), link);
      const before = tree(outside);

      await expect(resolveDraftDir(commonDir, 'x')).rejects.toBeInstanceOf(DraftBranchError);
      await expect(readDraft(commonDir, 'seen')).rejects.toBeInstanceOf(DraftBranchError);
      await expect(
        writeDraftTop(commonDir, 'x', 'hello', DRAFT_VERSION_ABSENT)
      ).rejects.toBeInstanceOf(DraftBranchError);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await listDrafts(commonDir)).toEqual([]);
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(' warn ');
      } finally {
        stderr.mockRestore();
      }
      expect(tree(outside)).toEqual(before);
    });
  }
});

describe('readDraft', () => {
  it('is all null with nothing on disk', async () => {
    expect(await readDraft(commonDir, 'feature')).toEqual({
      branch: 'feature',
      top: null,
      suggested: null,
      ai: null,
      adoptedUnedited: false,
      version: DRAFT_VERSION_ABSENT,
    });
  });

  it('reads all three zones', async () => {
    put('feature', 'top.md', 'mine');
    put('feature', 'top.suggested.md', 'theirs');
    put('feature', 'ai.md', '<details>x</details>');
    expect(await readDraft(commonDir, 'feature')).toEqual({
      branch: 'feature',
      top: 'mine',
      suggested: 'theirs',
      ai: '<details>x</details>',
      adoptedUnedited: false,
      version: sha('mine'),
    });
  });

  it('does not follow a top.md that is a link', async () => {
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.mkdirSync(path.dirname(draftFile('feature', 'top.md')), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret'), draftFile('feature', 'top.md'));
    const err = await readDraft(commonDir, 'feature').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftFileError);
    expect((err as DraftFileError).file).toBe('top.md');
  });

  it('refuses an oversize file', async () => {
    put('feature', 'ai.md', 'x'.repeat(MAX_DRAFT_BYTES + 1));
    await expect(readDraft(commonDir, 'feature')).rejects.toBeInstanceOf(DraftFileError);
  });

  it('refuses a FIFO without blocking', async () => {
    fs.mkdirSync(path.dirname(draftFile('feature', 'ai.md')), { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [draftFile('feature', 'ai.md')]);
    await expect(readDraft(commonDir, 'feature')).rejects.toBeInstanceOf(DraftFileError);
  });
});

describe('writeDraftTop', () => {
  it('round-trips, and the version changes with the text', async () => {
    const first = await writeDraftTop(commonDir, 'feature/x', 'one', DRAFT_VERSION_ABSENT);
    expect(first.top).toBe('one');
    expect(first.version).toBe(sha('one'));
    const second = await writeDraftTop(commonDir, 'feature/x', 'two\n', first.version);
    expect(second.top).toBe('two\n');
    expect(second.version).not.toBe(first.version);
    expect(await readDraft(commonDir, 'feature/x')).toEqual(second);
  });

  it('refuses a stale version and writes nothing', async () => {
    const first = await writeDraftTop(commonDir, 'feature', 'one', DRAFT_VERSION_ABSENT);
    await writeDraftTop(commonDir, 'feature', 'two', first.version);
    await expect(writeDraftTop(commonDir, 'feature', 'three', first.version)).rejects.toThrow(
      DraftConflictError
    );
    expect((await readDraft(commonDir, 'feature')).top).toBe('two');
    await expect(writeDraftTop(commonDir, 'other', 'x', sha('not there'))).rejects.toBeInstanceOf(
      DraftConflictError
    );
    expect(fs.existsSync(path.join(draftsRoot(commonDir), 'other'))).toBe(false);
  });

  it('empty text removes top.md, adopted and the empty directories', async () => {
    put('feature/x', 'top.suggested.md', 'theirs');
    const adopted = await adoptSuggestion(commonDir, 'feature/x', DRAFT_VERSION_ABSENT);
    fs.unlinkSync(draftFile('feature/x', 'top.suggested.md'));
    const cleared = await writeDraftTop(commonDir, 'feature/x', '  \n', adopted.version);
    expect(cleared.top).toBeNull();
    expect(cleared.version).toBe(DRAFT_VERSION_ABSENT);
    expect(fs.existsSync(path.join(draftsRoot(commonDir), 'feature'))).toBe(false);
    expect(fs.existsSync(draftsRoot(commonDir))).toBe(true);
  });

  it('empty text leaves a directory that still holds ai.md', async () => {
    put('feature', 'ai.md', 'agent');
    const draft = await writeDraftTop(commonDir, 'feature', 'mine', DRAFT_VERSION_ABSENT);
    await writeDraftTop(commonDir, 'feature', '', draft.version);
    expect(tree(path.join(draftsRoot(commonDir), 'feature'))).toEqual(['ai.md']);
  });

  it('leaves no temp file behind', async () => {
    const draft = await writeDraftTop(commonDir, 'feature', 'one', DRAFT_VERSION_ABSENT);
    await writeDraftTop(commonDir, 'feature', 'two', draft.version);
    expect(tree(draftsRoot(commonDir))).toEqual(['feature', path.join('feature', 'top.md')]);
  });

  it('refuses a top.md that is a link and writes nothing through it', async () => {
    fs.writeFileSync(path.join(outside, 'target'), '');
    fs.mkdirSync(path.dirname(draftFile('feature', 'top.md')), { recursive: true });
    fs.symlinkSync(path.join(outside, 'target'), draftFile('feature', 'top.md'));
    await expect(
      writeDraftTop(commonDir, 'feature', 'x', DRAFT_VERSION_ABSENT)
    ).rejects.toBeInstanceOf(DraftFileError);
    expect(fs.readFileSync(path.join(outside, 'target'), 'utf8')).toBe('');
  });

  it('writes nothing when an agent file cannot be read', async () => {
    put('feature', 'ai.md', 'x'.repeat(MAX_DRAFT_BYTES + 1));
    await expect(
      writeDraftTop(commonDir, 'feature', 'hello', DRAFT_VERSION_ABSENT)
    ).rejects.toBeInstanceOf(DraftFileError);
    expect(tree(path.join(draftsRoot(commonDir), 'feature'))).toEqual(['ai.md']);

    put('kept', 'top.md', 'mine');
    put('kept', 'top.suggested.md', 'x'.repeat(MAX_DRAFT_BYTES + 1));
    await expect(writeDraftTop(commonDir, 'kept', '', sha('mine'))).rejects.toBeInstanceOf(
      DraftFileError
    );
    expect(fs.readFileSync(draftFile('kept', 'top.md'), 'utf8')).toBe('mine');
  });

  it('never touches the agent files', async () => {
    put('feature', 'top.suggested.md', 'theirs');
    put('feature', 'ai.md', 'agent');
    const old = new Date('2020-01-01T00:00:00Z');
    for (const name of ['top.suggested.md', 'ai.md'])
      fs.utimesSync(draftFile('feature', name), old, old);
    const stamp = (name: string) => fs.statSync(draftFile('feature', name)).mtimeMs;
    const before = [stamp('top.suggested.md'), stamp('ai.md')];

    const adopted = await adoptSuggestion(commonDir, 'feature', DRAFT_VERSION_ABSENT);
    const edited = await writeDraftTop(commonDir, 'feature', 'mine', adopted.version);
    await writeDraftTop(commonDir, 'feature', '', edited.version);

    expect(fs.readFileSync(draftFile('feature', 'top.suggested.md'), 'utf8')).toBe('theirs');
    expect(fs.readFileSync(draftFile('feature', 'ai.md'), 'utf8')).toBe('agent');
    expect([stamp('top.suggested.md'), stamp('ai.md')]).toEqual(before);
  });
});

describe('adoptSuggestion', () => {
  it('copies the suggestion and marks it unedited until the first edit', async () => {
    put('feature', 'top.suggested.md', 'Uses nginx. {{why?}}\n');
    const adopted = await adoptSuggestion(commonDir, 'feature', DRAFT_VERSION_ABSENT);
    expect(adopted.top).toBe('Uses nginx. {{why?}}\n');
    expect(adopted.adoptedUnedited).toBe(true);
    expect(fs.readFileSync(draftFile('feature', 'adopted'), 'utf8').trim()).toBe(adopted.version);

    const edited = await writeDraftTop(commonDir, 'feature', 'Uses nginx.\n', adopted.version);
    expect(edited.adoptedUnedited).toBe(false);
    expect(fs.existsSync(draftFile('feature', 'adopted'))).toBe(true);
  });

  it('adopts over a blank top.md', async () => {
    put('feature', 'top.suggested.md', 'theirs');
    put('feature', 'top.md', '  \n');
    const draft = await adoptSuggestion(commonDir, 'feature', sha('  \n'));
    expect(draft.top).toBe('theirs');
  });

  it('refuses over a top.md with text', async () => {
    put('feature', 'top.suggested.md', 'theirs');
    put('feature', 'top.md', 'mine');
    await expect(adoptSuggestion(commonDir, 'feature', sha('mine'))).rejects.toThrow(
      'top.md is not empty'
    );
    expect(fs.readFileSync(draftFile('feature', 'top.md'), 'utf8')).toBe('mine');
  });

  it('writes nothing when ai.md cannot be read', async () => {
    put('feature', 'top.suggested.md', 'theirs');
    put('feature', 'ai.md', 'x'.repeat(MAX_DRAFT_BYTES + 1));
    await expect(adoptSuggestion(commonDir, 'feature', DRAFT_VERSION_ABSENT)).rejects.toThrow(
      DraftFileError
    );
    expect(tree(path.join(draftsRoot(commonDir), 'feature'))).toEqual([
      'ai.md',
      'top.suggested.md',
    ]);
  });

  it('refuses without a suggestion', async () => {
    await expect(adoptSuggestion(commonDir, 'feature', DRAFT_VERSION_ABSENT)).rejects.toThrow(
      'No suggestion to start from'
    );
  });

  it('refuses a stale version', async () => {
    put('feature', 'top.suggested.md', 'theirs');
    put('feature', 'top.md', '');
    await expect(adoptSuggestion(commonDir, 'feature', DRAFT_VERSION_ABSENT)).rejects.toThrow(
      'Draft changed elsewhere'
    );
  });
});

describe('listDrafts', () => {
  it('is empty without a drafts directory', async () => {
    expect(await listDrafts(commonDir)).toEqual([]);
  });

  it('finds a and a/b, and ignores stray files and refused names', async () => {
    put('a', 'top.md', 'top of a');
    put('a/b', 'ai.md', 'ai of b');
    put('a/b', 'notes.txt', 'stray');
    put('c', 'notes.txt', 'not a draft');
    put('.hidden', 'top.md', 'refused name');
    fs.writeFileSync(path.join(draftsRoot(commonDir), 'top.md'), 'at the root');

    const drafts = await listDrafts(commonDir);
    expect(drafts.map((d) => d.branch)).toEqual(['a', 'a/b']);
    expect(drafts[0]).toMatchObject({
      hasTop: true,
      hasSuggested: false,
      hasAi: false,
      top: 'top of a',
      adoptedUnedited: false,
    });
    expect(drafts[1]).toMatchObject({ hasTop: false, hasAi: true, top: null });
    expect(drafts[0].mtime).toBe(fs.statSync(draftFile('a', 'top.md')).mtimeMs);
  });

  it('reports adopted-unedited', async () => {
    put('feature', 'top.suggested.md', 'theirs');
    await adoptSuggestion(commonDir, 'feature', DRAFT_VERSION_ABSENT);
    expect((await listDrafts(commonDir))[0].adoptedUnedited).toBe(true);
  });

  it('does not follow a linked directory', async () => {
    put('real', 'top.md', 'x');
    fs.mkdirSync(path.join(outside, 'evil'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'evil', 'top.md'), 'outside');
    fs.symlinkSync(path.join(outside, 'evil'), path.join(draftsRoot(commonDir), 'linked'));
    expect((await listDrafts(commonDir)).map((d) => d.branch)).toEqual(['real']);
  });

  it('skips a directory removed while the walk runs', async () => {
    put('a', 'top.md', 'x');
    put('b', 'top.md', 'x');
    const readdir = fs.promises.readdir;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
      dir: fs.PathLike,
      options: unknown
    ) => {
      const entries = await (readdir as (d: fs.PathLike, o: unknown) => Promise<unknown>)(
        dir,
        options
      );
      // A PUT with an empty top lands between two reads.
      if (dir === draftsRoot(commonDir)) {
        fs.rmSync(path.join(draftsRoot(commonDir), 'b'), { recursive: true });
      }
      return entries;
    }) as typeof fs.promises.readdir);
    try {
      expect((await listDrafts(commonDir)).map((d) => d.branch)).toEqual(['a']);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves out a directory it cannot read and logs it', async () => {
    put('a', 'top.md', 'x');
    put('locked', 'top.md', 'x');
    const readdir = fs.promises.readdir;
    const locked = path.join(draftsRoot(commonDir), 'locked');
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((
      dir: fs.PathLike,
      options: unknown
    ) => {
      if (dir === locked) {
        return Promise.reject(
          Object.assign(new Error(`EACCES: permission denied, scandir '${locked}'`), {
            code: 'EACCES',
          })
        );
      }
      return (readdir as (d: fs.PathLike, o: unknown) => Promise<unknown>)(dir, options);
    }) as typeof fs.promises.readdir);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect((await listDrafts(commonDir)).map((d) => d.branch)).toEqual(['a']);
      const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain(' warn ');
      expect(logged).toContain('locked');
    } finally {
      stderr.mockRestore();
      spy.mockRestore();
    }
  });

  it('leaves out a draft with a bad file and logs it', async () => {
    put('good', 'top.md', 'x');
    put('bad', 'ai.md', 'x'.repeat(MAX_DRAFT_BYTES + 1));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect((await listDrafts(commonDir)).map((d) => d.branch)).toEqual(['good']);
      const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain(' warn ');
      expect(logged).toContain('ai.md');
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('draftChangeOfEntry', () => {
  it('maps each kind of entry', () => {
    const cases: Array<[string, boolean, unknown]> = [
      ['diffstalker', true, { branch: '', prefix: true }],
      ['diffstalker/pr', true, { branch: '', prefix: true }],
      ['diffstalker/pr/feature', true, { branch: 'feature', prefix: true }],
      ['diffstalker/pr/feature/x', true, { branch: 'feature/x', prefix: true }],
      ['diffstalker/pr/feature/top.md', false, { branch: 'feature', prefix: false }],
      ['diffstalker/pr/feature/x/ai.md', false, { branch: 'feature/x', prefix: false }],
      ['diffstalker/pr/a/top.suggested.md', false, { branch: 'a', prefix: false }],
      ['diffstalker/pr/a/adopted', false, { branch: 'a', prefix: false }],
      ['diffstalker/pr/a/.top.md.123.1.tmp', false, null],
      ['diffstalker/pr/a/.top.md.swp', false, null],
      ['diffstalker/pr/top.md', false, null],
      ['diffstalker/other', false, null],
      ['diffstalker/other/top.md', false, null],
      ['refs/heads/main', false, null],
      ['info/exclude', false, null],
      ['HEAD', false, null],
    ];
    for (const [rel, isDir, expected] of cases) {
      expect(draftChangeOfEntry(rel, isDir), rel).toEqual(expected);
    }
  });
});
