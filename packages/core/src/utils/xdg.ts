/**
 * XDG base-directory paths for diffstalker.
 *
 * Defaults match the XDG spec fallbacks (~/.config, ~/.cache); the env
 * variables are honored when set. XDG_RUNTIME_DIR has no spec fallback,
 * so runtimeDir() returns null when it is unset — callers decide what
 * refusing to run looks like (no silent /tmp fallback).
 */

import * as os from 'node:os';
import * as path from 'node:path';

const APP = 'diffstalker';

/** Config directory: $XDG_CONFIG_HOME/diffstalker or ~/.config/diffstalker. */
export function configDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP);
}

/** Cache directory: $XDG_CACHE_HOME/diffstalker or ~/.cache/diffstalker. */
export function cacheDir(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), APP);
}

/** Runtime directory: $XDG_RUNTIME_DIR/diffstalker, or null when unset. */
export function runtimeDir(): string | null {
  return process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, APP) : null;
}
