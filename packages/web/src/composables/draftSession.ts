/**
 * createDraftSession: the editor for one branch's PR draft
 * (docs/work-page.md §6). It follows `target()`: when that changes, it
 * sends what is waiting for the old target, then reads the new one's
 * draft and PR. The caller feeds it `draft-change` events and disposes it.
 *
 * Saving: 400 ms after the last keystroke, one PUT at a time, each based
 * on the version the last answer carried. A 409 means another tab or an
 * editor changed top.md: the text stays in the editor, saving stops, and
 * reload() takes the file's text. A `draft-change` re-reads the draft; our
 * own write comes back as the same version and changes nothing, an
 * agent's ai.md or suggestion is taken as is.
 *
 * GitHub (docs/work-page.md §3.6): with no top.md and an open PR, the
 * editor starts with the PR's top zone, and nothing is written until the
 * author types. takeGithub() saves GitHub's top zone as top.md; pushTop()
 * writes top.md into the PR's top zone, the one change to a PR there is.
 */

import { computed, effectScope, reactive, shallowRef, watch } from 'vue';
import { DiffstalkerClient } from '../api/client';
import { DaemonError, errorMessage } from '../api/errors';
import { logDaemonRefusal, logFailure } from '../stores/failureLog';
import { draftChangeTouches, topZoneOf } from '@diffstalker/core/view/prBody';
import { DRAFT_VERSION_ABSENT } from '@diffstalker/core/types/work';
import type { BranchPr, DraftChangeEvent, PrDraft } from '@diffstalker/core/types/work';

/** Quiet time after the last keystroke before a save. */
export const DRAFT_SAVE_DELAY_MS = 400;

/**
 * - idle: the editor holds what the file holds;
 * - dirty: typed, not sent yet;
 * - saving: a PUT is in flight;
 * - conflict: the file changed elsewhere; nothing is saved until reload();
 * - error: the last save failed; the next keystroke tries again.
 */
export type DraftSaveState = 'idle' | 'dirty' | 'saving' | 'conflict' | 'error';

/** The repo and branch a draft belongs to. */
export interface DraftTarget {
  id: string;
  branch: string;
}

export interface DraftSession {
  /** The bound branch; null while the target is null. */
  readonly branch: string | null;
  readonly draft: PrDraft | null;
  /** The editor's text. */
  readonly text: string;
  /** The top.md version `text` was last saved over or read from. */
  readonly baseVersion: string;
  readonly save: DraftSaveState;
  readonly error: string | null;
  readonly pr: BranchPr | null;
  readonly loading: boolean;
  readonly checkingPrs: boolean;
  /** The open PR's top zone on GitHub, as last read; null without an open PR. */
  readonly githubTop: string | null;
  /** The editor shows GitHub's top zone because there is no top.md; nothing is saved yet. */
  readonly prefilled: boolean;
  /** pushTop() is running. */
  readonly pushing: boolean;
  /** The editor changed. */
  setText(value: string): void;
  /** Take the file's text, dropping what the editor holds. */
  reload(): Promise<void>;
  /** "start from this": the agent's suggestion becomes top.md. */
  adopt(): Promise<void>;
  /** Ask GitHub again: this PR alone when one is known, else every PR. */
  checkPrs(): Promise<void>;
  /** Read the PR fresh and save its top zone as top.md. */
  takeGithub(): Promise<void>;
  /** Write top.md into the PR's top zone on GitHub. */
  pushTop(): Promise<void>;
  /** Save now instead of after the delay, through the normal path. */
  saveNow(): void;
  /** A `draft-change` from the repo's stream. */
  onDraftChange(event: DraftChangeEvent): void;
  /** Send what is waiting, then stop; settles once that last write has. */
  dispose(): Promise<void>;
}

export function createDraftSession(target: () => DraftTarget | null): DraftSession {
  const client = new DiffstalkerClient();

  /** Where everything below goes, fixed until the next reset. A save captures it when sent. */
  const bound = shallowRef<DraftTarget | null>(null);
  const draft = shallowRef<PrDraft | null>(null);
  const text = shallowRef('');
  const baseVersion = shallowRef<string>(DRAFT_VERSION_ABSENT);
  const save = shallowRef<DraftSaveState>('idle');
  const error = shallowRef<string | null>(null);
  const pr = shallowRef<BranchPr | null>(null);
  const loading = shallowRef(false);
  const checkingPrs = shallowRef(false);
  const prefilled = shallowRef(false);
  const pushing = shallowRef(false);

  const githubTop = computed<string | null>(() => {
    const open = pr.value?.pr ?? null;
    if (open === null || open.state !== 'open' || open.body === null) return null;
    return topZoneOf(open.body);
  });

  /** Bumps on every target change, reload and dispose: older answers are dropped. */
  let generation = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Text was typed that no PUT has carried yet. */
  let pendingWrite = false;
  /** The PUT in flight; resolves to the version it wrote, or null when it failed. */
  let inFlight: Promise<string | null> | null = null;
  /** A draft-change arrived during a save; handled when the save is done. */
  let changeWaiting = false;
  let disposed: Promise<void> | null = null;
  /** Prefill only until the author types: a cleared editor stays clear. */
  let prefillAllowed = true;

  /** Something in the editor is not on disk yet. */
  function hasUnsaved(): boolean {
    return pendingWrite || inFlight !== null || save.value === 'error';
  }

  function clearSaveTimer(): void {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  function takeAll(next: PrDraft): void {
    draft.value = next;
    prefilled.value = false;
    text.value = next.top ?? '';
    baseVersion.value = next.version;
    save.value = 'idle';
    error.value = null;
  }

  async function pullPr(at: DraftTarget, gen: number): Promise<void> {
    try {
      const answer = await client.branchPr(at.id, at.branch);
      if (gen === generation) pr.value = answer;
    } catch (err) {
      // The PR line just stays as it was; the reason goes to the console.
      if (gen === generation)
        logDaemonRefusal('read the PR of a branch', err, { branch: at.branch });
    }
  }

  async function loadDraft(at: DraftTarget, gen: number): Promise<void> {
    loading.value = true;
    try {
      const next = await client.draft(at.id, at.branch);
      if (gen !== generation) return;
      takeAll(next);
    } catch (err) {
      if (gen !== generation) return;
      logFailure('read PR draft', err, { branch: at.branch });
      error.value = `Could not read the draft: ${errorMessage(err)}`;
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  /**
   * Send what is waiting for the target being left, after any save in
   * flight. Settles once that last write has.
   */
  async function flushOnLeave(): Promise<void> {
    clearSaveTimer();
    const at = bound.value;
    const before = inFlight;
    // A failed save left the text off disk with nothing pending: send it too.
    if (at === null || (!pendingWrite && save.value !== 'error')) {
      if (before !== null) await before;
      return;
    }
    pendingWrite = false;
    const top = text.value;
    const base = baseVersion.value;
    const version = (before === null ? null : await before) ?? base;
    try {
      await client.putDraft(at.id, { branch: at.branch, top, version });
    } catch (err) {
      logFailure('save PR draft', err, { branch: at.branch });
    }
  }

  /** Drop everything that belongs to the old target. */
  function reset(): void {
    generation += 1;
    bound.value = null;
    clearSaveTimer();
    pendingWrite = false;
    inFlight = null;
    changeWaiting = false;
    draft.value = null;
    text.value = '';
    prefilled.value = false;
    prefillAllowed = true;
    baseVersion.value = DRAFT_VERSION_ABSENT;
    save.value = 'idle';
    error.value = null;
    pr.value = null;
    loading.value = false;
    pushing.value = false;
  }

  /** Bind to a target, and read both the draft and its PR. */
  function bindAndLoad(next: DraftTarget | null): void {
    if (next === null) return;
    const at = { id: next.id, branch: next.branch };
    bound.value = at;
    const gen = generation;
    void loadDraft(at, gen);
    void pullPr(at, gen);
  }

  function flushSave(): void {
    saveTimer = null;
    const at = bound.value;
    if (inFlight !== null || !pendingWrite || at === null) return;
    pendingWrite = false;
    const gen = generation;
    const sent = text.value;
    save.value = 'saving';
    inFlight = sendSave(at, sent, gen);
  }

  async function sendSave(at: DraftTarget, sent: string, gen: number): Promise<string | null> {
    let written: string | null = null;
    try {
      const next = await client.putDraft(at.id, {
        branch: at.branch,
        top: sent,
        version: baseVersion.value,
      });
      written = next.version;
      if (gen !== generation) return written;
      draft.value = next;
      baseVersion.value = next.version;
      save.value = pendingWrite ? 'dirty' : 'idle';
      error.value = null;
    } catch (err) {
      if (gen !== generation) return null;
      if (err instanceof DaemonError && err.status === 409) {
        // Kept in the editor; the reload button takes the file's text.
        logFailure('save PR draft', err, { branch: at.branch });
        save.value = 'conflict';
        pendingWrite = false;
        clearSaveTimer();
      } else {
        logFailure('save PR draft', err, { branch: at.branch });
        save.value = 'error';
        error.value = `Could not save: ${errorMessage(err)}`;
      }
    }
    if (gen === generation) afterSave();
    return written;
  }

  function saveNow(): void {
    if (save.value === 'error') pendingWrite = true;
    clearSaveTimer();
    flushSave();
  }

  function afterSave(): void {
    inFlight = null;
    if (changeWaiting) {
      changeWaiting = false;
      void rereadAfterChange();
    }
    if (pendingWrite && saveTimer === null && save.value !== 'conflict') flushSave();
  }

  function setText(value: string): void {
    text.value = value;
    prefilled.value = false;
    prefillAllowed = false;
    if (save.value === 'conflict' || bound.value === null) return;
    pendingWrite = true;
    if (inFlight === null) save.value = 'dirty';
    clearSaveTimer();
    saveTimer = setTimeout(flushSave, DRAFT_SAVE_DELAY_MS);
  }

  async function reload(): Promise<void> {
    const at = bound.value;
    if (at === null) return;
    clearSaveTimer();
    pendingWrite = false;
    prefillAllowed = true;
    generation += 1;
    inFlight = null;
    await loadDraft(at, generation);
  }

  async function adopt(): Promise<void> {
    const at = bound.value;
    if (at === null || hasUnsaved()) return;
    const gen = generation;
    try {
      const next = await client.adoptDraft(at.id, {
        branch: at.branch,
        version: baseVersion.value,
      });
      if (gen === generation) takeAll(next);
    } catch (err) {
      if (gen !== generation) return;
      logFailure('start from the suggestion', err, { branch: at.branch });
      // Show what is on disk now, then say why the click did nothing.
      await loadDraft(at, gen);
      if (gen === generation)
        error.value = `Could not start from the suggestion: ${errorMessage(err)}`;
    }
  }

  async function checkPrs(): Promise<void> {
    const at = bound.value;
    if (at === null) return;
    const gen = generation;
    checkingPrs.value = true;
    try {
      if (pr.value?.pr) {
        const answer = await client.checkBranchPr(at.id, at.branch);
        if (gen === generation) pr.value = answer;
      } else {
        await client.refreshWorkPrs();
        await pullPr(at, gen);
      }
    } catch (err) {
      if (gen !== generation) return;
      logFailure('check PRs', err);
      error.value = `Could not check PRs: ${errorMessage(err)}`;
    } finally {
      checkingPrs.value = false;
    }
  }

  async function takeGithub(): Promise<void> {
    const at = bound.value;
    if (at === null || hasUnsaved() || save.value === 'conflict') return;
    await checkPrs();
    const top = githubTop.value;
    if (top === null || bound.value !== at) return;
    setText(top);
    saveNow();
  }

  async function pushTop(): Promise<void> {
    const at = bound.value;
    const shown = githubTop.value;
    if (at === null || shown === null || hasUnsaved() || draft.value?.top == null) return;
    const gen = generation;
    pushing.value = true;
    try {
      const answer = await client.setPrTopZone(at.id, {
        branch: at.branch,
        version: baseVersion.value,
        expectedTop: shown,
      });
      if (gen !== generation) return;
      pr.value = answer;
      error.value = null;
    } catch (err) {
      if (gen !== generation) return;
      logFailure('update the PR top zone', err, { branch: at.branch });
      error.value = `Could not update GitHub: ${errorMessage(err)}`;
      // A 409 means GitHub moved on: show its text as it is now.
      if (err instanceof DaemonError && err.status === 409) {
        try {
          const answer = await client.checkBranchPr(at.id, at.branch);
          if (gen === generation) pr.value = answer;
        } catch (checkErr) {
          logDaemonRefusal('read the PR of a branch', checkErr, { branch: at.branch });
        }
      }
    } finally {
      if (gen === generation) pushing.value = false;
    }
  }

  async function rereadAfterChange(): Promise<void> {
    const at = bound.value;
    if (at === null) return;
    const gen = generation;
    const base = baseVersion.value;
    let next: PrDraft;
    try {
      next = await client.draft(at.id, at.branch);
    } catch (err) {
      if (gen === generation) logDaemonRefusal('re-read PR draft', err, { branch: at.branch });
      return;
    }
    if (gen !== generation) return;
    // A save started or ended while the GET was out, so the answer may be
    // older or newer than our base: read again once no save is running.
    if (inFlight !== null) {
      changeWaiting = true;
      return;
    }
    if (baseVersion.value !== base) {
      void rereadAfterChange();
      return;
    }
    if (next.version === baseVersion.value || save.value === 'conflict') {
      // Our own write coming back, or only the agent's files moved.
      if (draft.value !== null) {
        draft.value = {
          ...draft.value,
          suggested: next.suggested,
          ai: next.ai,
          adoptedUnedited: next.adoptedUnedited,
        };
      }
    } else if (hasUnsaved()) {
      save.value = 'conflict';
      pendingWrite = false;
      clearSaveTimer();
    } else {
      takeAll(next);
    }
    void pullPr(at, gen);
  }

  function onDraftChange(event: DraftChangeEvent): void {
    const at = bound.value;
    if (at === null || !draftChangeTouches(event, at.branch)) return;
    if (inFlight !== null) {
      changeWaiting = true;
      return;
    }
    void rereadAfterChange();
  }

  /** No top.md and an open PR: show GitHub's top zone, and write nothing until the author types. */
  function prefill(): void {
    const top = githubTop.value;
    if (!prefillAllowed || top === null || top === '') return;
    if (draft.value === null || draft.value.top !== null) return;
    if (hasUnsaved() || save.value !== 'idle' || text.value !== '') return;
    text.value = top;
    prefilled.value = true;
  }

  const scope = effectScope(true);
  scope.run(() => {
    watch([draft, githubTop], prefill);
    watch(
      target,
      (next) => {
        const was = bound.value;
        if (next?.id === was?.id && next?.branch === was?.branch) return;
        void flushOnLeave();
        reset();
        bindAndLoad(next);
      },
      { immediate: true }
    );
  });

  function dispose(): Promise<void> {
    if (disposed === null) {
      // Taken before reset(): the text, its base and the save in flight.
      const last = flushOnLeave();
      scope.stop();
      reset();
      disposed = last;
    }
    return disposed;
  }

  return reactive({
    branch: computed(() => bound.value?.branch ?? null),
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
    setText,
    reload,
    adopt,
    checkPrs,
    takeGithub,
    pushTop,
    saveNow,
    onDraftChange,
    dispose,
  });
}
