/**
 * `diffstalker link` — print a web-UI URL for a place in a repo.
 *
 * The point is not saving you the typing. It is that a hand-written
 * diffstalker URL fails SILENTLY: a path that is not view-first names no
 * place at all, and an `at` that matches nothing leaves the view aimed at
 * nothing. Neither looks broken to whoever clicks it; it just looks like
 * you meant somewhere unhelpful. So every input this command cannot verify
 * is an error on stderr with a non-zero exit, and the URL is only printed
 * once the daemon has confirmed the repo, the file, and the anchor exist.
 * Failure moves from click-time-and-quiet to build-time-and-loud, which is
 * the only place it can actually be fixed.
 *
 * Written for a coding agent as much as for a person: one command, one line
 * of stdout, and a diagnostic that says which of the four things was wrong.
 *
 *   diffstalker link                              # journal, whole session
 *   diffstalker link src/App.vue                  # explorer (view defaults)
 *   diffstalker link changes src/App.vue          # resolves the u:/s: side
 *   diffstalker link history HEAD                 # resolves to a short hash
 *   diffstalker link compare src/a.ts --base main
 *
 * The URL grammar itself is shared with the web client
 * (@diffstalker/core/view/urlGrammar) — this file only decides WHICH place
 * is meant and proves it exists.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DiffstalkerClient } from '@diffstalker/client';
import { buildUrlPath, isViewName } from '@diffstalker/core/view/urlGrammar';
import type { ViewName } from '@diffstalker/core/view/urlGrammar';
import { resolveSocketPath } from '../daemon/DaemonLifecycle.js';

/** Thrown for every "you asked for something that isn't there" case. */
export class LinkError extends Error {}

export interface LinkArgs {
  view: ViewName;
  /** A repo-relative-or-absolute file path, or a commit-ish for history. */
  target: string | null;
  base: string | null;
  socketPath?: string;
  instance?: string;
  /** Directory the paths are relative to, and the repo is resolved from. */
  cwd: string;
}

const USAGE = `Usage: diffstalker link [view] [target] [options]

  view     changes | journal | history | compare | explorer
           Defaults to explorer when a target is given, journal otherwise.
  target   a file path (changes/compare/explorer) or a commit-ish (history).
           Prefix a path with ./ if it collides with a view name.

Options:
  --base REF        compare only: the base branch to compare against
  --socket PATH     daemon socket to ask (default: the usual one)
  --instance NAME   named daemon to ask

Environment:
  DIFFSTALKER_WEB_URL   base URL to build links against, when the daemon's
                        own loopback port is not how you reach it
                        (an ssh tunnel, or a .localhost hostname).`;

/**
 * Parse argv after `link`. The first token is a view only when it is one of
 * the five keywords — the same view-first, closed-set rule the URL grammar
 * uses, so `link history` is the view and `link ./history` is the directory.
 */
/** The three value-taking options, split out from the positional words. */
interface LinkOptions {
  positional: string[];
  base: string | null;
  socketPath?: string;
  instance?: string;
}

const VALUE_OPTIONS = ['--base', '--socket', '--instance'] as const;

function parseOptions(argv: string[]): LinkOptions {
  const out: LinkOptions = { positional: [], base: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((VALUE_OPTIONS as readonly string[]).includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new LinkError(`${arg} needs a value`);
      if (arg === '--base') out.base = value;
      else if (arg === '--socket') out.socketPath = value;
      else out.instance = value;
      continue;
    }
    if (arg.startsWith('-')) throw new LinkError(`unknown option: ${arg}\n\n${USAGE}`);
    out.positional.push(arg);
  }
  return out;
}

export function parseLinkArgs(argv: string[], cwd: string): LinkArgs {
  const { positional, base, socketPath, instance } = parseOptions(argv);
  let view: ViewName;
  let target: string | null;

  if (positional.length > 0 && isViewName(positional[0])) {
    view = positional[0];
    target = positional[1] ?? null;
    if (positional.length > 2) throw new LinkError(`too many arguments\n\n${USAGE}`);
  } else {
    target = positional[0] ?? null;
    if (positional.length > 1) throw new LinkError(`too many arguments\n\n${USAGE}`);
    // No view keyword: a target is a file, which is the explorer; nothing
    // at all is "show me this session", which is the journal.
    view = target === null ? 'journal' : 'explorer';
  }

  if (base !== null && view !== 'compare') {
    throw new LinkError(`--base applies to compare, not ${view}`);
  }
  if (target !== null && view === 'journal') {
    throw new LinkError('journal has no anchor — its entry seqs are not stable identities');
  }
  return { view, target, base, socketPath, instance, cwd };
}

/**
 * The base URL to hang the path off. The daemon reports the port it bound,
 * which is the truth for a local browser; DIFFSTALKER_WEB_URL overrides it
 * for the cases the daemon cannot know about (an ssh tunnel forwarding to a
 * different port, or a `.localhost` hostname the origin guard also allows).
 */
export function resolveBaseUrl(port: number | null, env: NodeJS.ProcessEnv): string {
  const override = env.DIFFSTALKER_WEB_URL;
  if (override !== undefined && override !== '') return override.replace(/\/+$/, '');
  if (port === null) {
    throw new LinkError(
      'this daemon serves no web UI — it bound a socket only, so there is no URL to link to.\n' +
        'Start it with a port (systemctl --user start diffstalkerd, or diffstalkerd --port 7337),\n' +
        'or set DIFFSTALKER_WEB_URL if you reach it some other way.'
    );
  }
  return `http://localhost:${port}`;
}

/** A path argument -> the repo-relative path, proven to exist on disk. */
function resolveRepoRelative(target: string, repoPath: string, cwd: string): string {
  const abs = path.resolve(cwd, target);
  const rel = path.relative(repoPath, abs);
  if (rel === '') {
    throw new LinkError(
      `${target} is the repo root, not a file inside it.\n` +
        'Drop the target to link the view itself.'
    );
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new LinkError(`${target} is outside the repo (${repoPath})`);
  }
  if (!fs.existsSync(abs)) {
    throw new LinkError(`no such file: ${abs}`);
  }
  return rel;
}

/**
 * Changes rows are keyed by SIDE as well as path — a partially staged file
 * is two rows — so the anchor has to name which one. A file that is not in
 * status has no row at all, and linking to it would land the view on
 * nothing; say so, and name the view that can actually show it.
 */
function changesAnchor(status: { files: { path: string; staged: boolean }[] }, rel: string): string {
  const rows = status.files.filter((f) => f.path === rel);
  if (rows.length === 0) {
    throw new LinkError(
      `${rel} has no uncommitted changes, so the changes view has no row for it.\n` +
        `Try: diffstalker link explorer ${rel}`
    );
  }
  // Both sides exist for a partially staged file. The unstaged row is the
  // live edit, and the one worth being pointed at.
  return rows.some((f) => !f.staged) ? `u:${rel}` : `s:${rel}`;
}

/** A commit-ish the user typed -> the short hash the history view anchors on. */
async function historyAnchor(
  client: LinkClient,
  repoId: string,
  target: string
): Promise<string> {
  const commits = await client.history(repoId, 200);
  if (commits.length === 0) throw new LinkError('this repo has no commits yet');
  if (target === 'HEAD') return commits[0].shortHash;
  const match = commits.find(
    (c) => c.hash === target || c.shortHash === target || c.hash.startsWith(target)
  );
  if (match === undefined) {
    throw new LinkError(
      `${target} is not one of the last ${commits.length} commits.\n` +
        'link history takes a hash from recent history, or HEAD.'
    );
  }
  return match.shortHash;
}

/**
 * The slice of DiffstalkerClient a link needs. Named so tests can hand in a
 * fake — a CLI test must never reach a real daemon.
 */
export type LinkClient = Pick<
  DiffstalkerClient,
  'health' | 'openRepo' | 'closeRepo' | 'status' | 'history'
>;

/**
 * Resolve the whole link. Opens the repo through the daemon — which
 * normalizes any path inside a worktree to its root, exactly as the web
 * client does — and releases it again, so this command leaves no repo open
 * that was not already.
 */
export async function buildLink(
  args: LinkArgs,
  env: NodeJS.ProcessEnv,
  client: LinkClient,
  socketPath: string
): Promise<string> {
  let health;
  try {
    health = await client.health();
  } catch {
    throw new LinkError(
      `no diffstalkerd is listening on ${socketPath}.\n` +
        'A link is only useful while the daemon is up: systemctl --user start diffstalkerd.'
    );
  }
  // Resolved before the repo is opened, so "no web UI" fails without
  // leaving a refcount behind.
  const baseUrl = resolveBaseUrl(health.http?.port ?? null, env);

  let repo;
  try {
    repo = await client.openRepo(args.cwd);
  } catch {
    throw new LinkError(`${args.cwd} is not inside a git repository`);
  }

  try {
    let at: string | null = null;
    if (args.target !== null) {
      if (args.view === 'history') {
        at = await historyAnchor(client, repo.id, args.target);
      } else {
        const rel = resolveRepoRelative(args.target, repo.path, args.cwd);
        if (args.view === 'changes') {
          const shared = await client.status(repo.id);
          if (shared.status === null) throw new LinkError('the daemon has no status for this repo');
          at = changesAnchor(shared.status, rel);
        } else {
          at = rel;
        }
      }
    }
    const urlPath = buildUrlPath({
      view: args.view,
      repoPath: repo.path,
      home: health.home ?? null,
      at,
      base: args.base,
    });
    return baseUrl + urlPath;
  } finally {
    // Refcounted: this releases only the ref this command took.
    await client.closeRepo(repo.id).catch(() => {});
  }
}

/** Entry point for `diffstalker link ...`. Returns the process exit code. */
export async function runLink(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  try {
    const args = parseLinkArgs(argv, process.cwd());
    const socketPath = resolveSocketPath(args.socketPath, env, args.instance);
    const client = new DiffstalkerClient({ socketPath });
    console.log(await buildLink(args, env, client, socketPath));
    return 0;
  } catch (err) {
    if (err instanceof LinkError) {
      console.error(`diffstalker link: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
