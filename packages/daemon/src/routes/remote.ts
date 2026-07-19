/**
 * Remote / branch / undo routes: push, fetch, pull, stash, stash-pop,
 * switch-branch, create-branch, soft-reset, cherry-pick, revert, plus
 * abort / rebase-continue for recovering a repo stopped mid-operation —
 * each wrapping the repo's RemoteOperationManager through runRemoteMutation
 * (in-progress -> 409, conflict/rejection -> 409, other failure -> 500,
 * success -> the unified {state, result} envelope).
 *
 * Ref-like fields (branch names, commit hashes) go through requireRefField,
 * which rejects flag-shaped values (leading '-') with a 400 — defense in
 * depth on top of the end-of-options guards in core.
 *
 * The manager schedules a working-tree refresh after every successful op,
 * so the existing `state-change` SSE event already tells other clients to
 * re-pull; the initiating client gets the refreshed state synchronously in
 * this response. A dedicated `remote-state-change` SSE type (live progress
 * for clients that did NOT start the op) is a Phase-3 multi-client
 * decision, deliberately not part of this slice.
 *
 * Branch listing stays on GET /repos/:id/branches (historyCompare.ts) —
 * not duplicated here.
 */

import { getInProgressOperation } from '@diffstalker/core/git/status';
import { commitExists } from '@diffstalker/core/git/diff';
import { Router, HttpError } from '../router.js';
import {
  optionalIntField,
  optionalStringField,
  requireRepo,
  requireRefField,
  runRemoteMutation,
  type RouteDeps,
} from './shared.js';

export function registerRemoteRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.post('/repos/:id/push', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    await runRemoteMutation(handle, res, () => handle.manager.remote.push());
  });

  router.post('/repos/:id/fetch', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    await runRemoteMutation(handle, res, () => handle.manager.remote.fetchRemote());
  });

  router.post('/repos/:id/pull', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    await runRemoteMutation(handle, res, () => handle.manager.remote.pullRebase());
  });

  router.post('/repos/:id/stash', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const message = optionalStringField(body, 'message');
    await runRemoteMutation(handle, res, () => handle.manager.remote.stash(message));
  });

  router.post('/repos/:id/stash-pop', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const index = optionalIntField(body, 'index', { min: 0, fallback: 0 });
    await runRemoteMutation(handle, res, () => handle.manager.remote.stashPop(index));
  });

  router.post('/repos/:id/switch-branch', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const name = requireRefField(body, 'name');
    await runRemoteMutation(handle, res, () => handle.manager.remote.switchBranch(name));
  });

  router.post('/repos/:id/create-branch', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const name = requireRefField(body, 'name');
    await runRemoteMutation(handle, res, () => handle.manager.remote.createBranch(name));
  });

  router.post('/repos/:id/soft-reset', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const count = optionalIntField(body, 'count', { min: 1, fallback: 1 });
    // Resetting past the root commit would surface as git's confusing
    // "unknown revision" 500; reject it as the client error it is.
    if (!(await commitExists(handle.path, `HEAD~${count}`))) {
      throw new HttpError(
        400,
        `Cannot soft-reset ${count} commit(s): HEAD~${count} does not exist`
      );
    }
    await runRemoteMutation(handle, res, () => handle.manager.remote.softReset(count));
  });

  router.post('/repos/:id/cherry-pick', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const hash = requireRefField(body, 'hash');
    await runRemoteMutation(handle, res, () => handle.manager.remote.cherryPick(hash));
  });

  router.post('/repos/:id/revert', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const hash = requireRefField(body, 'hash');
    await runRemoteMutation(handle, res, () => handle.manager.remote.revertCommit(hash));
  });

  // Recovery from a repo stopped mid-operation (e.g. a pull --rebase that
  // hit conflicts): without these a headless client would be permanently
  // wedged in a state only fixable from a shell.

  router.post('/repos/:id/abort', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    if (!(await getInProgressOperation(handle.path))) {
      throw new HttpError(409, 'No operation in progress to abort');
    }
    await runRemoteMutation(handle, res, () => handle.manager.remote.abortOperation());
  });

  router.post('/repos/:id/rebase-continue', async ({ params, res }) => {
    const handle = requireRepo(registry, params.id);
    if ((await getInProgressOperation(handle.path)) !== 'rebase') {
      throw new HttpError(409, 'No rebase in progress to continue');
    }
    await runRemoteMutation(handle, res, () => handle.manager.remote.rebaseContinue());
  });
}
