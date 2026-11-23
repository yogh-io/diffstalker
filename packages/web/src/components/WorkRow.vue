<script setup lang="ts">
/**
 * One row of the Work page: one line of fixed columns (the page's grid,
 * through subgrid), and under it, when opened, the fold-out with the
 * activity, the facts and the PR draft.
 *
 * A click on the line opens or closes the fold-out. The PR number is a
 * link to GitHub and the compare button opens Compare: one click each.
 */

import { computed, ref } from 'vue';
import WorkIcon from './WorkIcon.vue';
import WorkRowDetail from './WorkRowDetail.vue';
import { useCopy } from '../composables/useCopy';
import { useWorkStore } from '../stores/work';
import {
  NOTE_LABELS,
  NOTE_SHORT,
  attentionLines,
  sessionBrief,
  STAGE_LABELS,
  STAGE_LEVEL,
  activeLastDay,
  activityText,
  workStatus,
  formatAgo,
  formatFull,
} from '../utils/workFormat';
import type { WorkItem, WorkMarkAction } from '@diffstalker/core/types/work';

const props = defineProps<{ item: WorkItem; now: number; dismissed?: boolean }>();

const emit = defineEmits<{
  open: [item: WorkItem];
  mark: [item: WorkItem, action: WorkMarkAction];
}>();

const expanded = ref(false);

function toggle(): void {
  expanded.value = !expanded.value;
}

const level = computed(() => STAGE_LEVEL[props.item.stage]);

const work = useWorkStore();

const status = computed(() => workStatus(props.item, work.prs?.viewer ?? null));

/** The When cell's hover: what happened, by whom, and the full date. */
const whenTip = computed(() => {
  const a = props.item.lastActivity;
  return a === null ? undefined : `${activityText(a)}\n${formatFull(a.at)}`;
});

const attention = computed(() => attentionLines(props.item).join('\n'));

/** Someone else's PR, which the author is asked to review. */
const theirs = computed(() => (props.item.pr?.reviewRequested ? props.item.pr.author : null));

const { state: copyState, copy } = useCopy();

const copyTip = computed(() => {
  if (copyState.value === 'copied') return 'Copied';
  if (copyState.value === 'failed') return 'Could not copy';
  return 'Copy the PR, repo and branch, to paste into a session';
});

const progress = computed(() => props.item.pr?.progress ?? null);

const reviewTitle = computed(() => {
  const p = progress.value;
  if (p === null) return undefined;
  const parts = [p.decision === null ? 'no review decision' : p.decision.replace('-', ' ')];
  if (p.unresolvedThreads > 0) parts.push(`${p.unresolvedThreads} open threads`);
  if (p.pendingReviewers > 0) parts.push(`${p.pendingReviewers} reviewers asked`);
  return parts.join(' · ');
});

const reviewIcon = computed(() => {
  const p = progress.value;
  if (p === null || props.item.stage === 'draft') return null;
  if (p.decision === 'approved') return 'approved';
  if (p.decision === 'changes-requested') return 'changes';
  return 'waiting';
});

const checksTitle = computed(() => {
  const p = progress.value;
  if (p === null) return undefined;
  return p.checks === null ? 'no checks' : `checks: ${p.checks}`;
});

/** GitHub says the PR cannot merge as it is (`mergeable: CONFLICTING`). */
const conflicting = computed(() => progress.value?.conflicting ?? false);

const checksIcon = computed(() => {
  const checks = progress.value?.checks ?? null;
  if (checks === 'success') return 'check';
  if (checks === 'failure') return 'cross';
  if (checks === 'pending') return 'pending';
  return null;
});

const stackTitle = computed(() => {
  const stack = props.item.stack;
  return stack === null
    ? undefined
    : `Layer ${stack.position} of ${stack.size} in the stack on ${stack.root}`;
});

const draftTitle = computed(() => {
  const f = props.item.facts;
  const parts: string[] = [];
  if (f.draft) parts.push(f.adoptedUnedited ? 'draft: agent text, not edited' : 'draft');
  if (f.placeholders > 0) parts.push(`${f.placeholders} placeholders`);
  if (f.bodyDiffers) parts.push('differs from the PR on GitHub');
  return parts.length === 0 ? undefined : parts.join(' · ');
});

const activity = computed(() => props.item.lastActivity);

const recent = computed(() => activeLastDay(props.item, props.now));

const canTrack = computed(
  () => !props.dismissed && props.item.section === 'candidates' && !props.item.tracked
);

const nameTitle = computed(() => {
  const lines = [props.item.branch ?? 'detached'];
  if (props.item.pr) lines.push(props.item.pr.title);
  if (props.item.worktreePath) lines.push(props.item.worktreePath);
  return lines.join('\n');
});
</script>

<template>
  <li
    class="work-row"
    :class="{ expanded, dim: dismissed }"
    :data-stage="item.stage"
    data-testid="work-row"
  >
    <div class="line" data-testid="work-row-line" @click="toggle">
      <span class="cell prog" :data-tip="STAGE_LABELS[item.stage]" data-testid="work-stage">
        <span class="pips" aria-hidden="true">
          <i v-for="n in 5" :key="n" :class="{ on: n <= level }" />
        </span>
        <span class="sr-only">{{ STAGE_LABELS[item.stage] }}</span>
        <span
          v-if="item.attention.length > 0"
          class="alert"
          data-testid="work-attention"
          :data-tip="attention"
          :aria-label="attention"
        >
          <WorkIcon name="alert" />
        </span>
      </span>

      <span class="cell name" :data-tip="nameTitle">
        <span class="branch mono">{{ item.branch ?? 'detached' }}</span>
        <span
          v-if="conflicting"
          class="conflicts"
          data-testid="work-conflicts"
          :data-tip="`GitHub says this branch has merge conflicts with ${item.pr?.baseRefName}`"
          >conflicts</span
        >
        <span v-if="theirs" class="by" data-testid="work-by">by {{ theirs }}</span>
        <span v-if="item.pr" class="pr-title">{{ item.pr.title }}</span>
      </span>

      <span class="cell stack" :data-tip="stackTitle" data-testid="work-stack">
        <template v-if="item.stack">
          <WorkIcon name="stack" />
          <span class="mono">{{ item.stack.position }}/{{ item.stack.size }}</span>
        </template>
      </span>

      <span class="cell pr">
        <a
          v-if="item.pr"
          class="pr-link mono"
          data-testid="work-pr-link"
          :href="item.pr.url"
          target="_blank"
          rel="noopener noreferrer"
          :data-tip="`Open #${item.pr.number} on GitHub`"
          @click.stop
          >#{{ item.pr.number }}</a
        >
      </span>

      <span class="cell review" :data-tip="reviewTitle" data-testid="work-review">
        <WorkIcon v-if="reviewIcon" :name="reviewIcon" :class="reviewIcon" />
        <span v-if="progress && progress.unresolvedThreads > 0" class="threads">
          <WorkIcon name="comment" />
          <span class="mono">{{ progress.unresolvedThreads }}</span>
        </span>
      </span>

      <span class="cell checks" :data-tip="checksTitle" data-testid="work-checks">
        <WorkIcon v-if="checksIcon" :name="checksIcon" :class="checksIcon" />
      </span>

      <span class="cell local mono" data-testid="work-local">
        <span
          v-if="item.facts.uncommitted > 0"
          class="uncommitted"
          :data-tip="`${item.facts.uncommitted} uncommitted`"
          >&#9679;{{ item.facts.uncommitted }}</span
        >
        <span
          v-if="item.facts.unpushed > 0"
          class="unpushed"
          :data-tip="`${item.facts.unpushed} unpushed`"
          >&uarr;{{ item.facts.unpushed }}</span
        >
        <span v-if="item.note" class="note" :data-tip="NOTE_LABELS[item.note]">{{
          NOTE_SHORT[item.note]
        }}</span>
      </span>

      <span class="cell draft" :data-tip="draftTitle" data-testid="work-draft">
        <WorkIcon
          v-if="item.facts.draft"
          name="pencil"
          :class="{ agent: item.facts.adoptedUnedited }"
        />
        <span v-if="item.facts.placeholders > 0" class="placeholders mono"
          >{{ '{' }}{{ item.facts.placeholders }}{{ '}' }}</span
        >
        <WorkIcon v-if="item.facts.bodyDiffers" name="differs" class="differs" />
      </span>

      <span
        class="cell status"
        :class="status.turn"
        :data-tip="status.why || undefined"
        data-testid="work-status"
        >{{ status.text }}</span
      >

      <span class="cell when" :class="{ recent }" :data-tip="whenTip" data-testid="work-when">{{
        activity ? formatAgo(activity.at, now) : ''
      }}</span>

      <span class="cell act">
        <button
          v-if="canTrack"
          class="action"
          data-testid="work-track"
          data-tip="Keep this in Work"
          @click.stop="emit('mark', item, 'track')"
        >
          Track
        </button>
        <button
          v-if="dismissed"
          class="action"
          data-testid="work-undismiss"
          @click.stop="emit('mark', item, 'undismiss')"
        >
          Show
        </button>
        <button
          v-if="!item.open && item.pr"
          class="icon-btn"
          :class="{ done: copyState === 'copied' }"
          data-testid="work-copy"
          :data-tip="copyTip"
          aria-label="Copy for a session"
          @click.stop="copy(sessionBrief(item))"
        >
          <WorkIcon :name="copyState === 'copied' ? 'check' : 'copy'" />
        </button>
        <button
          v-if="item.open"
          class="icon-btn"
          data-testid="work-compare"
          :data-tip="`Open ${item.branch ?? 'this worktree'} in Compare`"
          :aria-label="`Open ${item.branch ?? 'this worktree'} in Compare`"
          @click.stop="emit('open', item)"
        >
          <WorkIcon name="compare" />
        </button>
        <button
          class="icon-btn expand"
          data-testid="work-expand"
          :aria-expanded="expanded"
          :aria-label="expanded ? 'Close' : 'Show activity and draft'"
          @click.stop="toggle"
        >
          <WorkIcon name="chevron" />
        </button>
      </span>
    </div>

    <WorkRowDetail
      v-if="expanded"
      :item="item"
      :now="now"
      :dismissed="dismissed"
      @open="emit('open', item)"
      @mark="(action) => emit('mark', item, action)"
    />
  </li>
</template>

<style scoped>
.work-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  --stage: var(--text-dim);
}

.work-row[data-stage='pushed'] {
  --stage: var(--status-renamed);
}

.work-row[data-stage='draft'] {
  --stage: var(--selection);
}

.work-row[data-stage='review'] {
  --stage: var(--warn);
}

.work-row[data-stage='changes'],
.work-row[data-stage='gone'] {
  --stage: var(--del);
}

.work-row[data-stage='approved'] {
  --stage: var(--add);
}

.work-row[data-stage='merged'] {
  --stage: var(--syn-keyword);
}

.work-row + .work-row {
  border-top: 1px solid var(--border);
}

.line {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  align-items: center;
  min-height: 2rem;
  box-shadow: inset 3px 0 0 var(--stage);
  cursor: pointer;
}

.line:hover {
  background: var(--surface-raised);
}

.expanded > .line {
  background: var(--surface-raised);
}

.cell {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  white-space: nowrap;
  font-size: var(--fs-small);
}

.prog {
  /* Holds the hidden stage label: an absolute box with no positioned
     ancestor sits outside the scrolling workspace and stretches the page. */
  position: relative;
  padding-left: 0.75rem;
}

.pips {
  display: inline-flex;
  gap: 2px;
}

.alert {
  display: inline-flex;
  color: var(--del);
}

.by {
  flex: none;
  color: var(--accent);
  font-size: var(--fs-small);
}

.icon-btn.done {
  color: var(--add);
}

.pips i {
  width: 5px;
  height: 11px;
  border-radius: 1px;
  background: var(--border);
}

.pips i.on {
  background: var(--stage);
}

.name {
  gap: 0.625rem;
  font-size: var(--fs-content);
}

.branch {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pr-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-dim);
}

.stack {
  color: var(--status-renamed);
}

.pr-link {
  color: var(--accent);
  text-decoration: none;
}

.pr-link:hover {
  text-decoration: underline;
}

.approved,
.check {
  color: var(--add);
}

.changes,
.cross {
  color: var(--del);
}

.conflicts {
  flex: none;
  padding: 0 0.375rem;
  border: 1px solid var(--del);
  border-radius: 3px;
  color: var(--del);
  font-size: var(--fs-micro);
  font-weight: 600;
  line-height: 1.5;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.waiting {
  color: var(--text-dim);
}

.pending {
  color: var(--warn);
}

.threads {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  color: var(--warn);
}

.local {
  gap: 0.5rem;
}

.uncommitted {
  color: var(--uncommitted);
}

.unpushed {
  color: var(--warn);
}

.note {
  font-style: italic;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.draft {
  color: var(--accent);
}

.draft .agent {
  color: var(--text-dim);
}

.placeholders,
.differs {
  color: var(--warn);
}

.status {
  display: block;
  text-overflow: ellipsis;
}

.status.you {
  color: var(--text);
  font-weight: 600;
}

.status.others,
.status.none {
  color: var(--text-dim);
}

.when {
  justify-content: flex-end;
  color: var(--text-dim);
}

.when.recent {
  color: var(--text);
  font-weight: 600;
}

.act {
  justify-content: flex-end;
  padding-right: 0.375rem;
}

.action {
  padding: 0.0625rem 0.375rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: var(--fs-small);
  color: var(--text);
}

.action:hover {
  border-color: var(--text-dim);
}

.icon-btn {
  display: inline-flex;
  padding: 0.1875rem;
  border-radius: 3px;
  color: var(--text-dim);
}

.icon-btn:hover {
  color: var(--text);
  background: var(--border);
}

.expand .work-icon {
  transition: transform 0.12s;
}

.expanded .expand .work-icon {
  transform: rotate(90deg);
}

.dim > .line {
  opacity: 0.7;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
