/**
 * Explorer routes: stateless data reads (directory listing with git
 * status, file content as flags, the file-finder source). The
 * tree/selection view-model stays client-side; explorer data is pulled on
 * demand and the working-tree `state-change` SSE event already signals
 * changes.
 *
 * Both /tree and /file guard paths twice: lexically (../, absolute) and
 * by realpath (symlinks out of the repo), so the daemon never serves
 * host files through a repo symlink.
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
  parseBoolParam,
  requireRepo,
  requireRealWithinRoot,
  requireWithinRoot,
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
    requireWithinRoot(handle.path, dir);
    await requireRealWithinRoot(handle.path, dir);
    // Annotate from the manager's cached status (refreshing once when it
    // has never loaded), same source the TUI uses.
    const status = await ensureStatus(handle.manager.workingTree);
    const statusMap = buildGitStatusMap(status.files);
    let entries;
    try {
      entries = await listDirectory(
        handle.path,
        dir,
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
    sendJson(res, 200, await dropEntriesEscapingRoot(handle.path, entries));
  });

  router.get('/repos/:id/file', async ({ params, query, res }) => {
    const handle = requireRepo(registry, params.id);
    const relPath = query.get('path');
    if (!relPath) {
      throw new HttpError(400, 'Missing "path" query parameter');
    }
    requireWithinRoot(handle.path, relPath);
    await requireRealWithinRoot(handle.path, relPath);
    try {
      sendJson(res, 200, await readFileForDisplay(handle.path, relPath));
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
