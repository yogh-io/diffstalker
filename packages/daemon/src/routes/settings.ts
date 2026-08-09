/**
 * Daemon settings and the repository discovery they drive.
 *
 * GET/PUT /settings is the persistent daemon-level configuration; PUT
 * replaces the whole document, so a client sends the list it wants rather
 * than a patch it has to sequence. GET /browse lets a client walk the
 * daemon's directories to pick one.
 *
 * Registered on BOTH API surfaces, including the TCP one. The web UI is
 * the client that owns this panel, so a 'web'-only daemon that could not
 * answer here would have a settings screen it cannot save. What that
 * grants a local page is the directory NAMES under a directory the user
 * configured, and one small file written to the user's own config dir —
 * strictly less than POST /repos, which already runs git against any path
 * a page cares to name.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { listDirectories } from '@diffstalker/core/git/discoverRepos';
import { expandPath } from '@diffstalker/core/utils/pathUtils';
import { Router, HttpError, sendJson } from '../router.js';
import { normalizeWatchRoots } from '../settings.js';
import { requireStringArrayField, type RouteDeps } from './shared.js';

export function registerSettingsRoutes(router: Router, deps: RouteDeps): void {
  const { settings, discovery, daemonEvents } = deps;

  router.get('/settings', ({ res }) => {
    sendJson(res, 200, { ...settings.settings, persisted: settings.persisted });
  });

  router.put('/settings', async ({ body, res }) => {
    const requested = requireStringArrayField(body, 'watchRoots');

    let watchRoots: string[];
    try {
      watchRoots = normalizeWatchRoots(requested);
    } catch (err) {
      // The reason the path was refused is the whole point of the reply —
      // it is the user's own typed path coming back at them.
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }

    try {
      settings.save({ ...settings.settings, watchRoots });
    } catch (err) {
      // `.message`, not String(err), which glues an "Error:" into the
      // middle of a sentence the user reads. The errno text already names
      // the path and the cause.
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(500, `Could not save settings: ${reason}`);
    }

    // Scanning new roots happens before the reply, so the client's next
    // GET /discovered is not a race against its own save.
    await discovery.setRoots(watchRoots);

    const payload = { ...settings.settings, persisted: settings.persisted };
    // Other clients (a second tab, another browser) learn about it here.
    daemonEvents.broadcast('settings-change', payload);
    sendJson(res, 200, payload);
  });

  router.get('/discovered', ({ res }) => {
    sendJson(res, 200, discovery.state);
  });

  /**
   * One directory level of the daemon's filesystem, so a client can pick a
   * watch directory by browsing instead of typing an absolute path.
   *
   * The browsing HAS to happen here. A browser is never given a real path
   * by its own file pickers — `webkitdirectory` and `showDirectoryPicker`
   * both yield a bare folder name — so a "Browse…" button that stayed in
   * the page could not produce anything the daemon could open.
   *
   * Directory names only; no file names, no contents, and no dot
   * directories. That is a narrower disclosure than this daemon already
   * makes to any local page: POST /repos runs git against any path it is
   * given, and an opened repo serves file CONTENT.
   */
  router.get('/browse', async ({ query, res }) => {
    const requested = query.get('path');
    // No path means "start somewhere sensible": the daemon's home, which
    // is the user's home (it is loopback-only and runs as them).
    const expanded = requested ? expandPath(requested) : os.homedir();
    if (!path.isAbsolute(expanded)) {
      throw new HttpError(400, `Path must be absolute: ${requested}`);
    }

    const dir = path.resolve(expanded);
    let entries;
    try {
      entries = await listDirectories(dir);
    } catch {
      throw new HttpError(404, `Cannot read directory: ${dir}`);
    }

    const parent = path.dirname(dir);
    sendJson(res, 200, {
      path: dir,
      // At the filesystem root, dirname('/') is '/' — there is no up.
      parent: parent === dir ? null : parent,
      home: os.homedir(),
      entries,
    });
  });

  router.post('/discovered/rescan', async ({ res }) => {
    sendJson(res, 200, await discovery.rescan());
  });
}
