/**
 * Remote / branch / undo routes: push, fetch, pull, stash, stash-pop,
 * branch switch/create, soft reset, cherry-pick, and revert — each
 * wrapping the repo's RemoteOperationManager through runRemoteMutation
 * (in-progress -> 409, conflict/rejection -> 409, other failure -> 500,
 * success -> {result, operation}).
 *
 * The manager schedules a working-tree refresh after every successful op,
 * so the existing `state-change` SSE event already tells other clients to
 * re-pull; the initiating client gets the result synchronously in this
 * response. A dedicated `remote-state-change` SSE type (live progress for
 * clients that did NOT start the op) is a Phase-3 multi-client decision,
 * deliberately not part of this slice.
 *
 * Branch listing stays on GET /repos/:id/branches (historyCompare.ts) —
 * not duplicated here.
 */

import { Router } from '../router.js';
import {
  optionalIntField,
  optionalStringField,
  requireRepo,
  requireStringField,
  runRemoteMutation,
  type RouteDeps,
} from './shared.js';

export function registerRemoteRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.post('/repos/:id/push', async ({ params, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    await runRemoteMutation(remote, res, 'push', () => remote.push());
  });

  router.post('/repos/:id/fetch', async ({ params, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    await runRemoteMutation(remote, res, 'fetch', () => remote.fetchRemote());
  });

  router.post('/repos/:id/pull', async ({ params, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    await runRemoteMutation(remote, res, 'pull', () => remote.pullRebase());
  });

  router.post('/repos/:id/stash', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const message = optionalStringField(body, 'message');
    await runRemoteMutation(remote, res, 'stash', () => remote.stash(message));
  });

  router.post('/repos/:id/stash-pop', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const index = optionalIntField(body, 'index', { min: 0, fallback: 0 });
    await runRemoteMutation(remote, res, 'stash-pop', () => remote.stashPop(index));
  });

  router.post('/repos/:id/branch/switch', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const name = requireStringField(body, 'name');
    await runRemoteMutation(remote, res, 'branch-switch', () => remote.switchBranch(name));
  });

  router.post('/repos/:id/branch/create', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const name = requireStringField(body, 'name');
    await runRemoteMutation(remote, res, 'branch-create', () => remote.createBranch(name));
  });

  router.post('/repos/:id/reset/soft', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const count = optionalIntField(body, 'count', { min: 1, fallback: 1 });
    await runRemoteMutation(remote, res, 'soft-reset', () => remote.softReset(count));
  });

  router.post('/repos/:id/cherry-pick', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const hash = requireStringField(body, 'hash');
    await runRemoteMutation(remote, res, 'cherry-pick', () => remote.cherryPick(hash));
  });

  router.post('/repos/:id/revert', async ({ params, body, res }) => {
    const remote = requireRepo(registry, params.id).manager.remote;
    const hash = requireStringField(body, 'hash');
    await runRemoteMutation(remote, res, 'revert', () => remote.revertCommit(hash));
  });
}
