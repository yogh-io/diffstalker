<script setup lang="ts">
/**
 * The PR draft panel (docs/work-page.md §6), top to bottom: the PR line,
 * the editor for the author's zone (top.md), an agent's suggestion, the
 * AI zone (read-only), and the raw body as `gh` would send it, with
 * `{{…}}` placeholders marked.
 *
 * Given a `session`, the panel edits that session's branch; the caller
 * binds and disposes it. Without one it drafts for Compare's branch,
 * through the draft store.
 *
 * Drafts hold text that agents write, so everything here renders as text:
 * the preview is built from text nodes, never v-html.
 *
 * The panel writes top.md (through the session), and never touches the
 * suggestion or the AI zone. With an open PR and no top.md it starts from
 * the PR's top zone. When the saved words differ from the PR's top zone it
 * says so, and offers "Take GitHub's text" (into top.md) and "Update
 * GitHub" (top.md into the PR's top zone, after a second click). That
 * button is the one place diffstalker changes a PR (docs/work-page.md §3.6).
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDraftStore } from '../stores/draft';
import type { DraftSession } from '../composables/draftSession';
import {
  bodyDiffersFromDraft,
  composeBody,
  countPlaceholders,
  placeholderRanges,
  replaceTopZone,
} from '@diffstalker/core/view/prBody';
import { checkedLine, ghNotice } from '../utils/workFormat';

const props = defineProps<{ session?: DraftSession }>();

/** Compare's branch choice; null when a session is given. */
const store = props.session === undefined ? useDraftStore() : null;

onMounted(() => store?.start());
onBeforeUnmount(() => store?.stop());

/** What the panel shows and edits: the given session, or the store. */
const draft = computed(() => props.session ?? useDraftStore());

const loadingBranches = computed(() => store !== null && !store.branchesKnown);
const noBranch = computed(() => store !== null && store.branch === null);

const blank = computed(() => draft.value.text.trim() === '');

const suggestion = computed(() => draft.value.draft?.suggested ?? null);
const ai = computed(() => draft.value.draft?.ai ?? null);

/** A suggestion and nothing written yet: offer it, greyed, with "start from this". */
const offerSuggestion = computed(
  () => suggestion.value !== null && blank.value && draft.value.save === 'idle'
);

const linkedPr = computed(() => draft.value.pr?.pr ?? null);

const prStateLabel = computed(() => {
  const pr = linkedPr.value;
  if (pr === null) return '';
  if (pr.state === 'open') return pr.isDraft ? 'draft' : 'open';
  return pr.state;
});

const bodyDiffers = computed(() => {
  const pr = linkedPr.value;
  return (
    pr !== null &&
    pr.state === 'open' &&
    pr.body !== null &&
    !blank.value &&
    bodyDiffersFromDraft(pr.body, draft.value.text)
  );
});

/** The words are saved as top.md and differ from the PR: offer to sync either way. */
const offerSync = computed(
  () => bodyDiffers.value && draft.value.save === 'idle' && draft.value.draft?.top != null
);

const topPlaceholders = computed(() => countPlaceholders(draft.value.text));

/** "Update GitHub" asks once more before it writes. */
const confirmingPush = ref(false);

watch(offerSync, (offered) => {
  if (!offered) confirmingPush.value = false;
});

async function pushTop(): Promise<void> {
  confirmingPush.value = false;
  await draft.value.pushTop();
}

/** What to say when there is no PR to show; every case offers "check PRs". */
const prNote = computed<string | null>(() => {
  const answer = draft.value.pr;
  if (answer === null || answer.pr !== null) return null;
  if (answer.status === 'never') return 'PR state not checked';
  const notice = ghNotice(answer.status, answer.message);
  if (notice !== null) return notice;
  const checked =
    answer.checkedAt === null
      ? ''
      : ` · ${checkedLine(answer.checkedAt, answer.viewer, Date.now())}`;
  return `No PR for this branch${checked}`;
});

const saveLine = computed<string | null>(() => {
  switch (draft.value.save) {
    case 'dirty':
    case 'saving':
      return 'saving…';
    case 'conflict':
      return 'changed elsewhere';
    case 'error':
      return draft.value.error;
    default:
      return draft.value.draft?.adoptedUnedited ? 'agent text, not edited' : null;
  }
});

/** An open PR's body is what "Update GitHub" would make of it: your words over GitHub's lower zone. */
const openBody = computed(() => {
  const pr = linkedPr.value;
  return pr !== null && pr.state === 'open' && pr.body !== null ? pr.body : null;
});

const body = computed(() =>
  openBody.value === null
    ? composeBody(draft.value.text, ai.value)
    : replaceTopZone(openBody.value, draft.value.text)
);
const placeholders = computed(() => countPlaceholders(body.value));

/** The preview as plain-text pieces, the placeholders marked. */
const pieces = computed(() => {
  const text = body.value;
  const out: { text: string; hole: boolean }[] = [];
  let at = 0;
  for (const range of placeholderRanges(text)) {
    if (range.start > at) out.push({ text: text.slice(at, range.start), hole: false });
    out.push({ text: text.slice(range.start, range.end), hole: true });
    at = range.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hole: false });
  return out;
});

function onInput(event: Event): void {
  draft.value.setText((event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <aside class="draft-panel" data-testid="pr-draft-panel" aria-label="PR draft">
    <header class="panel-head">
      <span class="eyebrow">PR draft</span>
      <span v-if="draft.branch" class="branch mono" :data-tip="draft.branch">{{
        draft.branch
      }}</span>
    </header>

    <p v-if="loadingBranches" class="note">Loading…</p>
    <p v-else-if="noBranch" class="note" data-testid="draft-no-branch">
      No local branch to draft for. Pick a layer that is a local branch, or check one out.
    </p>

    <template v-else>
      <p class="pr-line" data-testid="draft-pr-line">
        <template v-if="linkedPr">
          <a
            class="pr-link mono"
            :href="linkedPr.url"
            target="_blank"
            rel="noopener noreferrer"
            :data-tip="linkedPr.title"
            >PR #{{ linkedPr.number }}</a
          >
          <span class="pr-state">{{ prStateLabel }}</span>
          <button
            class="small-btn"
            data-testid="draft-check-pr"
            :disabled="draft.checkingPrs"
            data-tip="Read this PR from GitHub again"
            @click="draft.checkPrs()"
          >
            {{ draft.checkingPrs ? 'checking…' : 'check again' }}
          </button>
        </template>
        <template v-else-if="prNote">
          <span class="dim">{{ prNote }}</span>
          <button
            class="small-btn"
            data-testid="draft-check-prs"
            :disabled="draft.checkingPrs"
            @click="draft.checkPrs()"
          >
            {{ draft.checkingPrs ? 'checking…' : 'check PRs' }}
          </button>
        </template>
      </p>

      <label class="editor-label eyebrow" for="pr-draft-top">Your words (top.md)</label>
      <p v-if="draft.prefilled" class="note dim" data-testid="draft-prefilled">
        From the PR on GitHub. Saved as top.md once you edit.
      </p>
      <textarea
        id="pr-draft-top"
        class="editor mono"
        data-testid="draft-editor"
        spellcheck="true"
        :value="draft.text"
        :disabled="draft.loading"
        placeholder="What this change is and why. {{like this}} marks a gap to fill."
        @input="onInput"
      ></textarea>
      <p class="save-line" data-testid="draft-save-line">
        <span
          v-if="saveLine"
          :class="{ warn: draft.save === 'conflict' || draft.save === 'error' }"
          >{{ saveLine }}</span
        >
        <button
          v-if="draft.save === 'conflict'"
          class="small-btn"
          data-testid="draft-reload"
          data-tip="Drop what is typed here and take the file's text"
          @click="draft.reload()"
        >
          reload
        </button>
      </p>
      <p
        v-if="draft.error && draft.save !== 'error'"
        class="note view-error"
        data-testid="draft-error"
      >
        {{ draft.error }}
      </p>

      <section v-if="offerSync" class="sync" data-testid="draft-body-differs">
        <p class="sync-line">
          <span class="differs">Your words differ from the PR on GitHub.</span>
          <button
            class="small-btn"
            data-testid="draft-take-github"
            :disabled="draft.checkingPrs || draft.pushing"
            data-tip="Read the PR again and save its top zone as top.md"
            @click="draft.takeGithub()"
          >
            Take GitHub's text
          </button>
          <button
            v-if="!confirmingPush"
            class="small-btn"
            data-testid="draft-push"
            :disabled="draft.pushing || topPlaceholders > 0"
            :data-tip="
              topPlaceholders > 0
                ? 'Fill the {{…}} placeholders first'
                : 'Put your words in the PR\'s top zone on GitHub'
            "
            @click="confirmingPush = true"
          >
            {{ draft.pushing ? 'updating…' : 'Update GitHub…' }}
          </button>
        </p>
        <p v-if="confirmingPush" class="sync-line confirm" data-testid="draft-push-confirm">
          <span
            >Replace the top zone of PR #{{ linkedPr?.number }} on GitHub with your words? The part
            below the line stays as it is.</span
          >
          <button class="small-btn primary" data-testid="draft-push-yes" @click="pushTop()">
            Update GitHub
          </button>
          <button class="small-btn" @click="confirmingPush = false">Cancel</button>
        </p>
        <details class="github-top">
          <summary class="eyebrow">GitHub's text</summary>
          <pre class="text-block mono" data-testid="draft-github-top">{{ draft.githubTop }}</pre>
        </details>
      </section>

      <section v-if="offerSuggestion" class="suggestion offered" data-testid="draft-suggestion">
        <span class="eyebrow">agent suggestion</span>
        <pre class="text-block mono">{{ suggestion }}</pre>
        <button class="small-btn" data-testid="draft-adopt" @click="draft.adopt()">
          start from this
        </button>
      </section>
      <details v-else-if="suggestion !== null" class="suggestion" data-testid="draft-suggestion">
        <summary class="eyebrow">agent suggestion</summary>
        <pre class="text-block mono">{{ suggestion }}</pre>
      </details>

      <details v-if="ai !== null" class="ai-zone" data-testid="draft-ai">
        <summary class="eyebrow">AI zone (ai.md)</summary>
        <pre class="text-block mono">{{ ai }}</pre>
      </details>

      <section class="preview-section">
        <span class="eyebrow"
          >{{ openBody === null ? 'body as sent' : 'body after Update GitHub' }}
          <span v-if="placeholders > 0" class="holes" data-testid="draft-placeholder-count"
            >· {{ placeholders }} {{ placeholders === 1 ? 'placeholder' : 'placeholders' }}</span
          ></span
        >
        <pre
          class="text-block preview mono"
          data-testid="draft-preview"
        ><template v-for="(piece, index) in pieces" :key="index"><mark v-if="piece.hole" class="hole">{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></pre>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.draft-panel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.panel-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}

.branch {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.note,
.pr-line,
.save-line {
  margin: 0;
  font-size: var(--fs-small);
}

.note,
.dim {
  color: var(--text-dim);
}

.pr-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.5rem;
}

.pr-link {
  color: var(--accent);
  text-decoration: none;
}

.pr-link:hover {
  text-decoration: underline;
}

.pr-state {
  color: var(--text-dim);
}

.differs,
.warn {
  color: var(--warn);
}

.small-btn {
  padding: 0 0.375rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.small-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--text-dim);
}

.small-btn:disabled {
  opacity: 0.6;
}

.small-btn.primary {
  color: var(--text);
  border-color: var(--warn);
}

.sync {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
  border-radius: 4px;
}

.sync-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-size: var(--fs-small);
}

.editor-label {
  margin-top: 0.25rem;
}

.editor {
  width: 100%;
  min-height: 10rem;
  resize: vertical;
  font-size: var(--fs-base);
  line-height: 1.5;
}

.save-line {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-height: 1.2em;
  color: var(--text-dim);
}

.suggestion,
.ai-zone,
.preview-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.suggestion summary,
.ai-zone summary {
  cursor: pointer;
}

.suggestion.offered .text-block {
  color: var(--text-dim);
  font-style: italic;
}

.suggestion.offered .small-btn {
  align-self: flex-start;
  color: var(--text);
}

.text-block {
  margin: 0;
  padding: 0.5rem;
  max-height: 20rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--fs-small);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.preview {
  max-height: none;
}

.hole {
  color: var(--text);
  background: color-mix(in srgb, var(--warn) 30%, transparent);
  border-radius: 2px;
}

.holes {
  color: var(--warn);
}
</style>
