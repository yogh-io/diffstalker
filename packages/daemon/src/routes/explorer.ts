/**
 * Explorer routes: stateless data reads (directory listing with git
 * status, file content as flags, the file-finder source). The
 * tree/selection view-model stays client-side; explorer data is pulled on
 * demand and the working-tree `state-change` SSE event already signals
 * changes.
 *
 * Both /tree and /file guard paths twice: lexically (requireRepoRelPath:
 * ../, absolute, NUL, git option/pathspec shapes, any .git segment of the
 * normalized path) and by realpath (requireRealRepoPath: symlinks out of
 * the repo, and anything landing in the real git directory). So the daemon
 * never serves host files through a repo symlink, and never serves the git
 * config — which carries credentials in remote URLs. The git directory is
 * dropped from the listing too: it is not browsable at all.
 */

import {
  buildGitStatusMap,
  listDirectory,
  readFileForDisplay,
  NotRegularFileError,
} from '@diffstalker/core/git/explorerData';
import { listAllFiles } from '@diffstalker/core/git/status';
import { Router, HttpError, sendJson } from '../router.js';
import {
  dropEntriesEscapingRoot,
  ensureStatus,
  fsErrorCode,
  isGitDirSegment,
  parseBoolParam,
  requireRepo,
  requireRealRepoPath,
  requireRepoRelPath,
  type RouteDeps,
} from './shared.js';

export function registerExplorerRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.get('/repos/:id/tree', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const dir = query.get('dir') ?? '';
    // hidden/ignored express the TUI's hideHidden/hideGitignored toggles;
    // defaults match the TUI defaults (both filtered).
    const hidden = parseBoolParam(query, 'hidden', false);
    const ignored = parseBoolParam(query, 'ignored', false);
    // The root listing carries no client path to validate; every other dir
    // goes through the pair, and the listing walks the normalized form.
    const rel = dir === '' ? '' : requireRepoRelPath(handle.path, dir);
    await requireRealRepoPath(handle, rel);
    // Annotate from the manager's cached status (refreshing once when it
    // has never loaded), same source the TUI uses.
    const status = await ensureStatus(handle.manager.workingTree);
    const statusMap = buildGitStatusMap(status.files);
    let entries;
    try {
      entries = await listDirectory(
        handle.path,
        rel,
        { hideHidden: !hidden, hideGitignored: !ignored },
        statusMap
      );
    } catch (err) {
      const code = fsErrorCode(err);
      if (code === 'ENOENT') {
        throw new HttpError(404, `No such directory: ${dir || '/'}`);
      }
      if (code === 'ENOTDIR') {
        throw new HttpError(400, `Not a directory: ${dir}`);
      }
      throw err;
    }
    // hidden=true would otherwise offer .git as a browsable directory, and
    // every path inside it is refused anyway — do not advertise it.
    const listed = entries.filter((entry) => !isGitDirSegment(entry.name));
    sendJson(res, 200, await dropEntriesEscapingRoot(handle.path, listed));
  });

  router.get('/repos/:id/file', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const relPath = query.get('path');
    if (!relPath) {
      throw new HttpError(400, 'Missing "path" query parameter');
    }
    const rel = requireRepoRelPath(handle.path, relPath);
    await requireRealRepoPath(handle, rel);
    try {
      sendJson(res, 200, await readFileForDisplay(handle.path, rel));
    } catch (err) {
      // Directories, FIFOs, sockets, devices: refused up front (a FIFO
      // read would block the event loop for every client).
      if (err instanceof NotRegularFileError) {
        throw new HttpError(400, err.message);
      }
      const code = fsErrorCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new HttpError(404, `No such file: ${relPath}`);
      }
      throw err;
    }
  });

  router.get('/repos/:id/files', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    sendJson(res, 200, await listAllFiles(handle.path));
  });
}
