<script setup lang="ts">
/**
 * A Work row's fold-out: what happened lately (PR events and local work,
 * newest first), the facts behind the row's icons, the actions, and the PR
 * draft editor for a local branch.
 */

import { computed } from 'vue';
import WorkDraftEditor from './WorkDraftEditor.vue';
import { useWorkStore } from '../stores/work';
import {
  attentionLines,
  formatAgo,
  formatFull,
  itemDetails,
  itemEvents,
  sessionBrief,
} from '../utils/workFormat';
import { useCopy } from '../composables/useCopy';
import type { WorkItem, WorkMarkAction } from '@diffstalker/core/types/work';

const props = defineProps<{ item: WorkItem; now: number; dismissed?: boolean }>();

const emit = defineEmits<{
  open: [];
  mark: [action: WorkMarkAction];
}>();

const work = useWorkStore();

/** The fold-out lists this many events at most. */
const EVENTS_SHOWN = 8;

const events = computed(() =>
  itemEvents(props.item, work.prs?.viewer ?? null).slice(0, EVENTS_SHOWN)
);

const details = computed(() => itemDetails(props.item));

const attention = computed(() => attentionLines(props.item));

const { state: copyState, copy } = useCopy();

const copyLabel = computed(() => {
  if (copyState.value === 'copied') return 'Copied';
  if (copyState.value === 'failed') return 'Could not copy';
  return 'Copy for a session';
});

/** A local branch with a checkout to open the repo from: its draft can be edited here. */
const draftAt = computed(() => {
  const { item } = props;
  if (item.kind !== 'branch' || item.branch === null || item.open === null) return null;
  return { path: item.open.path, branch: item.branch };
});
</script>

<template>
  <div class="detail" data-testid="work-detail" @click.stop>
    <section class="block events">
      <h3 class="eyebrow">Activity</h3>
      <p v-if="events.length === 0" class="none">Nothing recorded.</p>
      <ol v-else class="event-list">
        <li v-for="(event, i) in events" :key="i" class="event" :class="{ other: event.other }">
          <span class="at" :data-tip="formatFull(event.at)">{{ formatAgo(event.at, now) }}</span>
          <span class="text">{{ event.text }}</span>
        </li>
      </ol>
    </section>

    <section class="block facts">
      <h3 class="eyebrow">Facts</h3>
      <p v-for="line in attention" :key="line" class="wants" data-testid="work-detail-attention">
        {{ line }}
      </p>
      <dl class="fact-list">
        <template v-for="[label, value] in details" :key="label">
          <dt>{{ label }}</dt>
          <dd :data-tip="value">{{ value }}</dd>
        </template>
      </dl>
      <div class="actions">
        <button v-if="item.open" class="action" @click="emit('open')">Open in Compare</button>
        <button
          class="action"
          data-testid="work-detail-copy"
          data-tip="The PR, repo, local clone and branch, to paste into a session"
          @click="copy(sessionBrief(item))"
        >
          {{ copyLabel }}
        </button>
        <a
          v-if="item.pr"
          class="action"
          :href="item.pr.url"
          target="_blank"
          rel="noopener noreferrer"
          >Open #{{ item.pr.number }} on GitHub</a
        >
        <button
          v-if="item.tracked"
          class="action"
          data-testid="work-drop"
          @click="emit('mark', 'drop')"
        >
          Stop tracking
        </button>
        <button
          v-if="dismissed"
          class="action"
          data-testid="work-detail-undismiss"
          @click="emit('mark', 'undismiss')"
        >
          Show again
        </button>
        <button
          v-else
          class="action"
          data-testid="work-dismiss"
          data-tip="Hide this until something about it changes"
          @click="emit('mark', 'dismiss')"
        >
          Dismiss
        </button>
      </div>
    </section>

    <section v-if="draftAt" class="block draft">
      <WorkDraftEditor :path="draftAt.path" :branch="draftAt.branch" />
    </section>
  </div>
</template>

<style scoped>
.detail {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.75rem 1.5rem;
  padding: 0.75rem 1rem 1rem calc(0.75rem + 3px);
  border-top: 1px solid var(--border);
  box-shadow: inset 3px 0 0 var(--stage);
  background: var(--bg);
  cursor: auto;
}

.block {
  min-width: 0;
}

.draft {
  grid-column: 1 / -1;
}

.eyebrow {
  margin: 0 0 0.375rem;
}

.none {
  margin: 0;
  color: var(--text-dim);
  font-size: var(--fs-small);
}

.event-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--fs-small);
}

.event {
  display: flex;
  gap: 0.75rem;
  color: var(--text-dim);
  line-height: 1.6;
}

.event.other {
  color: var(--text);
}

.at {
  flex: none;
  width: 11rem;
}

.text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wants {
  margin: 0 0 0.375rem;
  color: var(--del);
  font-size: var(--fs-small);
  font-weight: 600;
}

.fact-list {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.125rem 0.75rem;
  margin: 0 0 0.625rem;
  font-size: var(--fs-small);
}

.fact-list dt {
  color: var(--text-dim);
}

.fact-list dd {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.action {
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: var(--fs-small);
  color: var(--text);
  text-decoration: none;
}

.action:hover {
  border-color: var(--text-dim);
}

@media (max-width: 48rem) {
  .detail {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
