/**
 * Shared factory for git process invocations.
 *
 * Pins the locale to C so git's error and porcelain text is stable English
 * regardless of the host locale — callers (the daemon's HTTP layer, the
 * TUI's error surfacing) classify failures like conflicts and rejected
 * pushes by matching that text.
 */
import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';

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

/** A simple-git instance for a repo with the pinned git environment. */
export function createGit(repoPath: string): SimpleGit {
  return simpleGit({ baseDir: repoPath, unsafe: ENV_PASSTHROUGH_UNSAFE }).env(gitEnv());
}
