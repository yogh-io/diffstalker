/**
 * useDraftStore: which branch Compare's draft panel drafts for
 * (docs/work-page.md §3, §6), and the draft session that edits it. Active
 * only while the panel is shown: the panel calls start() and stop().
 *
 * The branch is the picked layer's local branch, or HEAD's branch. Only
 * names that are local branches count; a detached HEAD or a layer with
 * only a remote-tracking name has no draft.
 */

import { computed, effectScope, shallowRef, watch } from 'vue';
import type { EffectScope } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import { errorMessage } from '../api/errors';
import { logFailure } from './failureLog';
import { useRepoStore } from './repo';
import { createDraftSession } from '../composables/draftSession';
import type { DraftSaveState, DraftSession, DraftTarget } from '../composables/draftSession';
import { DRAFT_VERSION_ABSENT } from '@diffstalker/core/types/work';

export const useDraftStore = defineStore('draft', () => {
  const client = new DiffstalkerClient();
  const repo = useRepoStore();

  /** Local branch names, and the repo they belong to; null until pulled. */
  const localBranches = shallowRef<{ id: string; names: string[] } | null>(null);
  /** Why the last branch list failed; cleared when one comes in. */
  const listError = shallowRef<string | null>(null);
  const session = shallowRef<DraftSession | null>(null);

  let scope: EffectScope | null = null;

  /** The names that could be the branch, best first. */
  const candidates = computed<string[]>(() => {
    const current = repo.shared.status?.branch?.current || null;
    const head = repo.selectedStackHead;
    if (head === null) return current === null ? [] : [current];
    const layer = repo.pickedLayer;
    if (layer === null) return [head];
    if (layer.isHead && current !== null)
      return [current, ...layer.refs.filter((ref) => ref !== current)];
    return layer.refs;
  });

  /** The branch the panel drafts for; null when there is no local branch (or not known yet). */
  const branch = computed<string | null>(() => {
    const local = localBranches.value;
    if (local === null || local.id !== repo.repoId) return null;
    return candidates.value.find((name) => local.names.includes(name)) ?? null;
  });

  /** The branch list is in for the current repo. */
  const branchesKnown = computed(() => localBranches.value?.id === repo.repoId);

  const draft = computed(() => session.value?.draft ?? null);
  const text = computed(() => session.value?.text ?? '');
  const baseVersion = computed(() => session.value?.baseVersion ?? DRAFT_VERSION_ABSENT);
  const save = computed<DraftSaveState>(() => session.value?.save ?? 'idle');
  const error = computed(() => listError.value ?? session.value?.error ?? null);
  const pr = computed(() => session.value?.pr ?? null);
  const loading = computed(() => session.value?.loading ?? false);
  const checkingPrs = computed(() => session.value?.checkingPrs ?? false);
  const githubTop = computed(() => session.value?.githubTop ?? null);
  const prefilled = computed(() => session.value?.prefilled ?? false);
  const pushing = computed(() => session.value?.pushing ?? false);

  function target(): DraftTarget | null {
    const id = repo.repoId;
    const name = branch.value;
    return id === null || name === null ? null : { id, branch: name };
  }

  async function pullBranches(): Promise<void> {
    const id = repo.repoId;
    if (id === null) {
      localBranches.value = null;
      listError.value = null;
      return;
    }
    try {
      const list = await client.localBranches(id);
      if (id !== repo.repoId) return;
      localBranches.value = { id, names: list.map((entry) => entry.name) };
      listError.value = null;
    } catch (err) {
      if (id !== repo.repoId) return;
      logFailure('list local branches', err);
      listError.value = `Could not list branches: ${errorMessage(err)}`;
    }
  }

  /** The stack's shape, as a string, so a re-pull of the same stack is no change. */
  const stackShape = computed(
    () => repo.compareStack?.layers.map((layer) => layer.refs.join(',')).join('|') ?? ''
  );

  /** The panel opened. */
  function start(): void {
    if (scope !== null) return;
    scope = effectScope(true);
    scope.run(() => {
      watch(
        [() => repo.repoId, () => repo.shared.status?.branch?.current ?? null, stackShape],
        () => void pullBranches(),
        { immediate: true }
      );
      watch(
        () => repo.lastDraftChange,
        (change) => {
          if (change !== null) session.value?.onDraftChange(change.event);
        }
      );
      // Sync: the old repo is released once the new one is open, and a
      // save sent after that is refused. The PUT must leave before that.
      watch(
        () => repo.switchStarts,
        () => session.value?.saveNow(),
        { flush: 'sync' }
      );
    });
    session.value = createDraftSession(target);
  }

  /** The panel closed: send what is waiting, then forget it all. */
  function stop(): void {
    void session.value?.dispose();
    session.value = null;
    scope?.stop();
    scope = null;
    localBranches.value = null;
    listError.value = null;
  }

  function setText(value: string): void {
    session.value?.setText(value);
  }

  async function reload(): Promise<void> {
    await session.value?.reload();
  }

  async function adopt(): Promise<void> {
    await session.value?.adopt();
  }

  async function checkPrs(): Promise<void> {
    await session.value?.checkPrs();
  }

  async function takeGithub(): Promise<void> {
    await session.value?.takeGithub();
  }

  async function pushTop(): Promise<void> {
    await session.value?.pushTop();
  }

  return {
    branch,
    branchesKnown,
    draft,
    text,
    baseVersion,
    save,
    error,
    pr,
    loading,
    checkingPrs,
    githubTop,
    prefilled,
    pushing,
    start,
    stop,
    setText,
    reload,
    adopt,
    checkPrs,
    takeGithub,
    pushTop,
  };
});
