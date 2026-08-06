/**
 * diffstalkerd entry point: parse CLI args, start the daemon, and shut
 * down cleanly on SIGINT/SIGTERM/SIGHUP.
 *
 * The unix socket is the daemon's identity: one per user, always bound
 * unless --no-socket. Resolution order is explicit --socket, then a systemd
 * socket-activation fd (LISTEN_FDS), then $XDG_RUNTIME_DIR/diffstalker/.
 * There is deliberately no /tmp fallback — a world-writable default would
 * hide the problem instead of surfacing it.
 *
 * --port ADDS the browser's transport rather than replacing the socket, so
 * one daemon serves the TUI and the web UI over a single git state. The
 * two listeners get different API surfaces; see server.ts modeFor.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runtimeDir, cacheDir } from '@diffstalker/core/utils/xdg';
import { expandPath } from '@diffstalker/core/utils/pathUtils';
import { createDaemon, type Daemon, ListenOptions } from './server.js';
import { readCurrentVersion } from './version.js';
import { resolveSymbolArtifacts } from './symbols/resolveArtifacts.js';

const SOCKET_NAME = 'diffstalkerd.sock';

/**
 * The socket file for a named instance. `--instance work` binds work.sock in
 * the same runtime dir, so a second daemon needs one word rather than an
 * absolute path spelled identically on both sides. No name means the default
 * socket, which is what every client looks for first.
 */
function socketNameFor(instance: string | undefined): string {
  return instance === undefined ? SOCKET_NAME : `${instance}.sock`;
}

/** systemd passes activated sockets starting at fd 3 (SD_LISTEN_FDS_START). */
const SD_LISTEN_FDS_START = 3;

const HELP = `diffstalkerd — diffstalker daemon (REST API + SSE over @diffstalker/core)

Usage: diffstalkerd [options] [REPO_PATH...]

Arguments:
  REPO_PATH            Repository to open on startup, so a client finds it
                       already there. Relative paths resolve against the
                       current directory and ~ expands; no path means no
                       repo is opened

Options:
  --socket PATH        Bind a unix socket at PATH
                       (default: $XDG_RUNTIME_DIR/diffstalker/${SOCKET_NAME})
  --instance NAME      Bind <NAME>.sock in the runtime dir, so several
                       daemons can run side by side (default: the shared
                       socket every client looks for first)
  --no-socket          Do not bind a unix socket (requires --port)
  --port N             Also bind TCP port N (loopback only) for the web UI.
                       The port serves the web API subset; the unix socket
                       keeps the full API
  --follow-file PATH   Hook file to follow (created when missing)
                       (default: ~/.cache/diffstalker/target)
  --no-follow          Disable follow mode (no hook-file watcher)
  --web-root PATH      Directory with the built web UI to serve at GET /
                       (default: web/ next to the daemon's compiled module;
                       when missing, the daemon serves the API only)
  --no-update-check    Never ask npm which version is latest; GET /version
                       then reports the running version only
  --version, -v        Print the running version and exit
  --help, -h           Show this help
`;

function expectValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export interface CliOptions extends ListenOptions {
  /** --no-socket: bind the TCP port only, no unix socket at all. */
  noSocket?: boolean;
  /**
   * --instance NAME: bind <NAME>.sock in the runtime dir instead of the
   * default socket, so several daemons can run side by side. Ignored when
   * --socket names a path outright.
   */
  instance?: string;
  /** Explicit hook file from --follow-file. */
  followFile?: string;
  /**
   * Explicit grammars directory. Distro packaging needs this: a
   * pacman-owned path has no node_modules for package resolution to find.
   * Also how tests point at the workspace copy.
   */
  grammarsDir?: string;
  /** --no-follow: no hook-file watcher at all. */
  noFollow?: boolean;
  /** Explicit web UI assets dir from --web-root. */
  webRoot?: string;
  /** --no-update-check: never reach out to the npm registry. */
  noUpdateCheck?: boolean;
  /**
   * Positional arguments: repositories to open on startup. Only ever
   * explicit paths — the daemon never opens its own working directory,
   * which for a systemd-launched process is whatever it happened to
   * inherit.
   */
  repoPaths?: string[];
}

/**
 * Record a positional argument: a repository to open on startup. An empty
 * argument is rejected rather than resolved, since it would silently mean
 * the daemon's own working directory.
 */
function addRepoPath(options: CliOptions, arg: string): void {
  if (arg.startsWith('-')) {
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (arg === '') {
    throw new Error('Empty repo path argument');
  }
  options.repoPaths ??= [];
  options.repoPaths.push(arg);
}

export function parseArgs(argv: string[]): CliOptions | 'help' | 'version' {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--version':
      case '-v':
        return 'version';
      case '--socket':
        options.socketPath = expectValue(argv, ++i, '--socket');
        break;
      case '--instance':
        options.instance = expectValue(argv, ++i, '--instance');
        break;
      case '--no-socket':
        options.noSocket = true;
        break;
      case '--port':
        options.port = Number(expectValue(argv, ++i, '--port'));
        if (!Number.isInteger(options.port) || options.port < 0) {
          throw new Error('--port requires a non-negative integer');
        }
        break;
      case '--follow-file':
        options.followFile = expectValue(argv, ++i, '--follow-file');
        break;
      case '--no-follow':
        options.noFollow = true;
        break;
      case '--web-root':
        options.webRoot = expectValue(argv, ++i, '--web-root');
        break;
      case '--grammars':
        options.grammarsDir = expectValue(argv, ++i, '--grammars');
        break;
      case '--no-update-check':
        options.noUpdateCheck = true;
        break;
      default:
        addRepoPath(options, arg);
        break;
    }
  }

  // --socket and --port are NOT exclusive: binding both is the normal
  // deployment (TUI on the socket, browser on the port, one git state).
  if (options.socketPath !== undefined && options.noSocket) {
    throw new Error('--socket and --no-socket are mutually exclusive');
  }
  if (options.noSocket && options.port === undefined) {
    throw new Error('--no-socket requires --port (nothing would be listening)');
  }
  if (options.followFile !== undefined && options.noFollow) {
    throw new Error('--follow-file and --no-follow are mutually exclusive');
  }
  return options;
}

/** True when systemd handed us pre-bound listening fds. */
function hasActivationFds(): boolean {
  return process.env.LISTEN_PID === String(process.pid) && Number(process.env.LISTEN_FDS) >= 1;
}

/**
 * Fill in the unix socket to bind, unless one was named explicitly or
 * --no-socket opted out: a systemd activation fd when present, otherwise
 * $XDG_RUNTIME_DIR/diffstalker/. A --port bind does NOT suppress this — the
 * socket is the daemon's identity, and skipping it is what leaves the TUI
 * spawning a second daemon alongside the web one.
 */
function applyListenDefaults(options: CliOptions): void {
  if (options.noSocket || options.socketPath !== undefined) return;

  if (hasActivationFds()) {
    options.fd = SD_LISTEN_FDS_START;
    return;
  }

  const dir = runtimeDir();
  if (!dir) {
    // With a port to fall back on this is a warning, not a failure: the web
    // UI still works, only the CLI transport is missing.
    if (options.port !== undefined) {
      console.error(
        'diffstalkerd: XDG_RUNTIME_DIR is not set; binding the TCP port only.\n' +
          'Pass --socket PATH to also accept CLI connections.'
      );
      return;
    }
    console.error(
      'diffstalkerd: XDG_RUNTIME_DIR is not set and no --socket/--port given.\n' +
        'Refusing to guess a socket location; pass --socket PATH or set XDG_RUNTIME_DIR.'
    );
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  options.socketPath = path.join(dir, socketNameFor(options.instance));
}

/**
 * Where the built web UI lives: --web-root when given, otherwise web/ next
 * to the daemon's own module (dist/web/ in the built package). When the
 * directory is missing the daemon runs API-only — one stderr line, never
 * fatal (a source checkout without a web build is the normal dev case).
 */
function resolveWebRoot(explicit?: string): string | undefined {
  const dir = explicit ?? fileURLToPath(new URL('web/', import.meta.url));
  if (fs.existsSync(dir)) return dir;
  console.error(`diffstalkerd: web UI assets not found at ${dir}; serving API only`);
  return undefined;
}

/**
 * Print the browser URL for the web UI on a TCP port. The daemon binds
 * loopback only, and *.localhost resolves to loopback with no config, so
 * the friendly host is the canonical bookmark.
 */
function announcePortAccess(port: number): void {
  console.error(`diffstalkerd: web UI at http://diffstalker.localhost:${port}/`);
}

/**
 * Open the repositories named on the command line, before anything is
 * listening: a client that connects then finds them in GET /repos instead
 * of an empty "type an absolute path" form.
 *
 * The paths are the user's, typed in a shell, so ~ expands and a relative
 * path resolves against the current directory. A path that will not open is
 * fatal — the daemon was told to serve it, and starting without it would
 * hand the user the same empty form with the reason buried in a log line.
 */
async function openStartupRepos(daemon: Daemon, repoPaths: string[]): Promise<void> {
  for (const raw of repoPaths) {
    const repoPath = path.resolve(expandPath(raw));
    try {
      const opened = await daemon.openRepo(repoPath);
      console.error(`diffstalkerd opened ${opened.path}`);
    } catch (err) {
      console.error(
        `diffstalkerd: cannot open ${repoPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      await daemon.close().catch(() => {});
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  process.title = 'diffstalkerd';

  let options: CliOptions | 'help' | 'version';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(HELP);
    process.exit(2);
  }

  if (options === 'help') {
    console.log(HELP);
    return;
  }

  if (options === 'version') {
    const version = readCurrentVersion();
    if (version === null) {
      // The manifest a running daemon can live without (GET /version says
      // 'unknown'); as an answer to --version there is nothing to print.
      console.error('diffstalkerd: version unknown (package.json unreadable)');
      process.exit(1);
    }
    console.log(version);
    return;
  }

  applyListenDefaults(options);

  // Follow is on by default: the daemon owns the hook file the TUI's follow
  // mode uses today. --no-follow disables it entirely.
  const followFile = options.noFollow
    ? undefined
    : (options.followFile ?? path.join(cacheDir(), 'target'));

  const webRoot = resolveWebRoot(options.webRoot);

  // Resolved HERE, in the entry module, for the same reason webRoot is: a
  // relative artifact path must be computed where import.meta.url still
  // points at a real location. `bun build` collapses every module's
  // import.meta.url into dist/index.js, so a resolution done deeper in the
  // tree would be correct in dev and wrong in the published bundle.
  const symbols = resolveSymbolArtifacts(
    options.grammarsDir ?? process.env.DIFFSTALKER_GRAMMARS_DIR ?? null,
    (message) => console.error(`diffstalkerd: ${message}`)
  );

  // apiMode is deliberately left unset: least privilege is decided per
  // listener by how well its transport is protected — a unix socket / an
  // inherited fd is owner-only and gets the full API (commit, discard, hunk
  // staging, remote/branch ops), a TCP port is reachable by any local
  // process and gets the web subset. See server.ts modeFor.
  const daemon = createDaemon({
    followFile,
    webRoot,
    symbols,
    updateCheck: !options.noUpdateCheck,
  });

  await openStartupRepos(daemon, options.repoPaths ?? []);

  await daemon.listen(options);

  // The port the kernel actually handed out, not the one asked for: --port 0
  // delegates the choice, and being told the result is the only way to use it.
  const tcp = daemon.addresses().find((addr): addr is AddressInfo => typeof addr !== 'string');
  const boundPort = tcp?.port ?? options.port;

  // Status lines go to stderr: stdout stays clean for piping, and journald
  // captures stderr just the same. One line per bound transport — there can
  // legitimately be more than one.
  if (options.fd !== undefined) {
    console.error(`diffstalkerd listening on inherited socket (fd ${options.fd})`);
  }
  if (options.socketPath) {
    console.error(`diffstalkerd listening on unix socket ${options.socketPath}`);
  }
  if (boundPort !== undefined) {
    console.error(`diffstalkerd listening on 127.0.0.1:${boundPort}`);
  }
  if (followFile) {
    console.error(`diffstalkerd following ${followFile}`);
  }
  if (webRoot) {
    console.error(`diffstalkerd serving web UI from ${webRoot}`);
    // A browser can only reach a TCP port (not a unix socket); print the URL.
    if (boundPort !== undefined) {
      announcePortAccess(boundPort);
    }
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}, shutting down`);
    daemon
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Nothing to reload yet; treat SIGHUP as a clean shutdown instead of the
  // default terminate-with-129.
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  const crash = (kind: string, err: unknown): void => {
    console.error(`diffstalkerd ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    // Best-effort cleanup (unlinks the socket file); then get out.
    daemon
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on('uncaughtException', (err) => crash('uncaught exception', err));
  process.on('unhandledRejection', (reason) => crash('unhandled rejection', reason));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
