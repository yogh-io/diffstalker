/**
 * Shared factory for git process invocations.
 *
 * Pins the locale to C so git's error and porcelain text is stable English
 * regardless of the host locale — callers (the daemon's HTTP layer, the
 * TUI's error surfacing) classify failures like conflicts and rejected
 * pushes by matching that text.
 */
import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { attributesFilePath } from './diffAttributes.js';

/** Environment for every git child process: inherit, but force locale C. */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

/**
 * simple-git blocks explicitly-provided env vars like EDITOR or
 * GIT_CONFIG_GLOBAL behind unsafe flags. We forward the parent process's
 * OWN environment — exactly what the git child would inherit if no env
 * were passed at all — so allowing these categories reintroduces nothing
 * that implicit inheritance did not already permit. No value in this env
 * ever comes from a client. allowUnsafeEditor additionally permits the
 * `-c core.editor=true` used by rebaseContinue.
 */
const ENV_PASSTHROUGH_UNSAFE: SimpleGitOptions['unsafe'] = {
  allowUnsafeEditor: true,
  allowUnsafeAskPass: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeDiffExternal: true,
  allowUnsafePager: true,
  allowUnsafeGitProxy: true,
  allowUnsafeTemplateDir: true,
  allowUnsafeSshCommand: true,
};

/**
 * How long a git invocation may sit silent before simple-git kills it.
 * Without a bound, a hung git — a stuck credential prompt, a remote that
 * never answers, a wedged filesystem — holds its queued operation open
 * for the life of the daemon.
 *
 * `block` is IDLE time, not total runtime, but idle is not the same as
 * "making no progress": git only writes progress to stderr when stderr is
 * a TTY, and simple-git spawns with pipes. So a fetch negotiating a pack,
 * or a commit running the user's pre-commit hook, is genuinely silent for
 * as long as it takes. Ten seconds is right for local plumbing reads and
 * badly wrong for anything that talks to a network or runs user code —
 * this repo's own pre-commit hook takes about 24 seconds.
 *
 * Hence two budgets. Long-running is still bounded, because an unbounded
 * one is the hazard this exists to close; it is just bounded at a length
 * no legitimate hook or transfer will reach.
 */
const GIT_IDLE_TIMEOUT_MS = 10_000;
const GIT_LONG_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface CreateGitOptions {
  /**
   * True for operations that legitimately go quiet for a long time:
   * anything running the user's hooks (commit, cherry-pick, revert,
   * rebase, merge) and anything talking to a remote (fetch, pull, push).
   * Everything else is a local plumbing read and takes the short budget.
   */
  longRunning?: boolean;
}

/** A simple-git instance for a repo with the pinned git environment. */
export function createGit(repoPath: string, options: CreateGitOptions = {}): SimpleGit {
  // Fills in funcname drivers for languages git ships regexes for. Omitted
  // when the file cannot be written — a read-only cache dir must not stop
  // git from running. See diffAttributes.ts, including which languages
  // this does NOT help.
  const attributesFile = attributesFilePath();
  const config = attributesFile === null ? [] : [`core.attributesFile=${attributesFile}`];

  return simpleGit({
    baseDir: repoPath,
    unsafe: ENV_PASSTHROUGH_UNSAFE,
    timeout: {
      block: options.longRunning === true ? GIT_LONG_IDLE_TIMEOUT_MS : GIT_IDLE_TIMEOUT_MS,
    },
    config,
  }).env(gitEnv());
}
