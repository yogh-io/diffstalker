<script setup lang="ts">
/**
 * RepoPicker: one input and one list, for every way into a repository.
 *
 * Mounted twice — inside the header's popover (RepoSwitcher) and inline on
 * the empty state — so the two can never drift apart. Everything it needs
 * comes from stores; the only thing it says outward is `opened`, which the
 * popover uses to close itself.
 *
 * The input does two jobs at once. It filters the whole list (open repos,
 * recents, discovered repos) as you type, and when what you typed PRECISELY
 * names a directory the daemon can open it grows an Open button. Those used
 * to be two controls stacked on each other — a path field with its own
 * button, and a filter buried mid-panel that narrowed only the discovered
 * list — which meant four ways in and no obvious one.
 *
 * "Precisely" is the whole contract of the button, and it is why the probe
 * (GET /resolve) is stricter than opening: git resolves a path that does
 * not exist to its PARENT worktree, so without that strictness a typo lights
 * the button up and opens the repo above it. See resolveRepoRoot.
 *
 * Row building — matching, dedup, section boundaries — is buildRepoRows, so
 * the render, the keyboard index and every count read one array.
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { clampMove, toSegments } from '@diffstalker/core/view/finderModel';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { useWorktreeStore } from '../stores/worktrees';
import { useRepoOpen } from '../composables/useRepoOpen';
import { beginUserNav } from '../composables/useUrlSync';
import { DiffstalkerClient } from '../api/client';
import { basename } from '../utils/format';
import {
  buildRepoRows,
  isSelectable,
  type OpenProject,
  type PickerRow,
  type RecentProject,
  type RepoRow,
  type SelectableRow,
} from './repoPickerRows';

const emit = defineEmits<{ opened: [] }>();

const daemon = useDaemonStore();
const repo = useRepoStore();
const settings = useSettingsStore();
const ui = useUiStore();
const worktreeStore = useWorktreeStore();
const { openByPath, activate } = useRepoOpen();
const client = new DiffstalkerClient();

/**
 * Picker-local, NOT useTextFilter: that composable reads useFilterStore,
 * which is the changes list's filter chip. Sharing it would tie the two.
 */
const query = ref('');
const expanded = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const trimmedQuery = computed(() => query.value.trim());

// --- Projects ------------------------------------------------------------

/**
 * Both lists below fold a project's worktrees into ONE row from the same
 * store, so a project reads identically here, in the trigger label and in
 * the worktree dropdown.
 */

const recentsNotOpen = computed(() =>
  ui.recentRepos.filter((path) => !daemon.repos.some((repo) => repo.path === path))
);

/** Every path the picker needs resolved: the open repos and the recents. */
const neededPaths = computed(() => [
  ...daemon.repos.map((repo) => repo.path),
  ...recentsNotOpen.value,
]);

/**
 * Resolve as the inputs change, not once at mount. The empty-state instance
 * mounts before the daemon's snapshot lands and then stays mounted: a
 * mount-only fetch would leave its rows unfolded forever, never retry a
 * failed lookup, and never see a repo opened in another tab. `ensure` skips
 * what it knows and dedups in flight, so this costs one request per unknown
 * path however often it fires.
 */
watch(neededPaths, (paths) => void worktreeStore.ensure(paths), { immediate: true });

const openProjects = computed<OpenProject[]>(() => {
  const groups = new Map<string, OpenProject>();
  for (const summary of daemon.repos) {
    // Unresolved: the repo stands as its own project (its path, its name).
    // It folds into its family the moment the entry lands.
    const resolved = worktreeStore.projectFor(summary.path);
    const root = resolved?.root ?? summary.path;
    let group = groups.get(root);
    if (!group) {
      group = { root, name: basename(root), repos: [], worktreeCount: 0, familyPaths: [] };
      groups.set(root, group);
    }
    group.repos.push(summary);
    // Every repo in a group belongs to the same family, so they all report
    // the same count; take whichever resolved (0 while none has yet).
    group.worktreeCount = Math.max(group.worktreeCount, resolved?.worktrees.length ?? 0);
    if (resolved) group.familyPaths = resolved.worktrees.map((worktree) => worktree.path);
  }
  return [...groups.values()];
});

/**
 * One row per project root, folding every recent path that resolved to the
 * same root. Which recents render, by worktree-store status:
 *  - unknown / pending: held back. Several worktrees of one project each
 *    resolve to the same row, so drawing them early shows a stray row per
 *    worktree that then vanishes;
 *  - absent: dropped — the daemon looked and the path is not a worktree
 *    (a removed directory still in prefs);
 *  - failed: rendered by its own path. We could not ask, so the entry is
 *    not evidence the path is bad, and the list must not silently lose it
 *    because the daemon blinked.
 */
const recentProjects = computed<RecentProject[]>(() => {
  const seen = new Map<string, RecentProject>();
  for (const path of recentsNotOpen.value) {
    const entry = worktreeStore.entryFor(path);
    if (entry === undefined || entry.status === 'pending' || entry.status === 'absent') continue;
    const project =
      entry.status === 'ready'
        ? entry.project
        : { root: path, name: basename(path), worktrees: [] };
    if (seen.has(project.root)) continue;
    seen.set(project.root, {
      root: project.root,
      name: project.name,
      worktreeCount: project.worktrees.length,
      familyPaths: project.worktrees.map((worktree) => worktree.path),
      // The freshest worktree of the family (the store sorts by activity),
      // or the root itself when nothing resolved.
      openPath: project.worktrees[0]?.path ?? project.root,
    });
  }
  return [...seen.values()];
});

// --- Rows ----------------------------------------------------------------

const rows = computed<PickerRow[]>(() =>
  buildRepoRows({
    openProjects: openProjects.value,
    recentProjects: recentProjects.value,
    discovered: settings.discoveredRepos,
    activeRepoId: daemon.activeRepoId,
    query: trimmedQuery.value,
    expanded: expanded.value,
    connected: daemon.connection !== 'disconnected',
    capped: settings.roots.some((root) => root.capped),
    now: Date.now(),
  })
);

/**
 * The keyboard index: every row you can act on, in DOM order. The reveal
 * control is last in both, which is why one array can index both halves
 * even though they render in different elements (see the template).
 */
const options = computed<SelectableRow[]>(() => rows.value.filter(isSelectable));

/** What the listbox draws: eyebrows and repo rows, never the control. */
const listRows = computed<Exclude<PickerRow, { kind: 'more' }>[]>(() =>
  rows.value.filter((row): row is Exclude<PickerRow, { kind: 'more' }> => row.kind !== 'more')
);

const moreRow = computed(() => rows.value.find((row) => row.kind === 'more') ?? null);

/** No REPO rows — the reveal control alone is not a list of repos. */
const noMatches = computed(() => listRows.value.every((row) => row.kind === 'section'));

/**
 * Re-walk the watch directories on mount: the daemon's watchers keep the
 * repo SET current, but a branch label only refreshes on a scan, and a scan
 * is filesystem-only (no git processes).
 */
onMounted(() => {
  void settings.rescan();
  inputEl.value?.focus();
});

// --- Selection -----------------------------------------------------------

/**
 * The selection is stored by KEY, not by index. Worktree lookups land
 * asynchronously, so rows fold and appear under the user's hands; an index
 * would quietly come to mean a different repo than the one under the rail,
 * and Enter would open it. Everything else here follows from that.
 */
const selectedKey = ref<string | null>(null);
/** Set by any arrow, ctrl-j/k or hover; reset on every input edit. */
const selectionMoved = ref(false);

const selectedIndex = computed(() => {
  const index = options.value.findIndex((row) => row.key === selectedKey.value);
  if (index !== -1) return index;
  // The keyed row is gone (or nothing is selected yet): fall back to the
  // top, which is the row the user means in every fresh state.
  return options.value.length > 0 ? 0 : -1;
});

const selectedRow = computed<SelectableRow | null>(
  () => options.value[selectedIndex.value] ?? null
);

/** Only a new query or a toggle resets the selection and the scroller. A
 * late worktree resolution must not — that would erase the survival the
 * keying exists for. */
function resetSelection(): void {
  selectedKey.value = null;
  selectionMoved.value = false;
  if (listEl.value) listEl.value.scrollTop = 0;
}

function moveSelection(delta: number): void {
  const count = options.value.length;
  if (count === 0) return;
  const from = selectedIndex.value === -1 ? 0 : selectedIndex.value;
  selectedKey.value = options.value[clampMove(from, delta, count)]?.key ?? null;
  selectionMoved.value = true;
  scrollSelectionIntoView();
}

function scrollSelectionIntoView(): void {
  const option = listEl.value?.querySelectorAll<HTMLElement>('.picker-row')[selectedIndex.value];
  option?.scrollIntoView?.({ block: 'nearest' });
}

function hover(row: SelectableRow): void {
  selectedKey.value = row.key;
  selectionMoved.value = true;
}

// --- Opening -------------------------------------------------------------

/**
 * Picker-local, deliberately. The old form read `repo.isRepo ? null :
 * repo.shared.error`, whose gate shows NOTHING for the commonest failure
 * here (a refusal while another repo is active leaves isRepo true), while
 * dropping the gate would put any live git error from the active repo's SSE
 * stream under the input, as if the typed path were at fault.
 */
const openError = shallowRef<string | null>(null);

async function openPath(path: string): Promise<void> {
  openError.value = null;
  beginUserNav({ repo: path });
  if (await openByPath(path)) {
    emit('opened');
    return;
  }
  openError.value = repo.shared.error ?? `Could not open ${path}`;
}

/** Activate an already-open project: keep the active worktree if it is in
 * this project, else switch to its first open worktree. */
async function openProject(project: OpenProject): Promise<void> {
  const active = project.repos.find((summary) => summary.id === daemon.activeRepoId);
  const target = active ?? project.repos[0];
  beginUserNav({ repo: target.path });
  await activate(target);
  emit('opened');
}

function chooseRow(row: SelectableRow): void {
  if (row.kind === 'more') {
    expanded.value = !expanded.value;
    resetSelection();
    return;
  }
  if (row.kind === 'open') {
    void openProject(row.project);
    return;
  }
  void openPath(row.kind === 'recent' ? row.project.openPath : row.path);
}

// --- The probe -----------------------------------------------------------

/** Debounce before asking the daemon. Discovery's watcher uses 300ms; the
 * finder's 15ms is for in-memory work and is the wrong scale for a call
 * that spawns git. */
const PROBE_DEBOUNCE_MS = 250;

type ProbeState = 'idle' | 'checking' | 'openable' | 'not-a-repo' | 'unreachable';

/**
 * `answeredFor` is what makes the button honest. The token below only
 * ORDERS answers; it cannot express "this answer is about a string you have
 * since edited". Both the button and the Enter shortcut require the answer
 * to be for the exact text in the input, so one more keystroke disarms them
 * in the same tick.
 */
const probe = shallowRef<{ state: ProbeState; answeredFor: string; root: string | null }>({
  state: 'idle',
  answeredFor: '',
  root: null,
});

/** Only an absolute-looking path is worth a round trip; everything else is
 * a filter and never touches the network. */
const pathLike = computed(() => /^[/~]/.test(trimmedQuery.value));

const canOpenTyped = computed(
  () => probe.value.state === 'openable' && probe.value.answeredFor === trimmedQuery.value
);

let probeTimer: ReturnType<typeof setTimeout> | null = null;
/** Monotonic: an answer that is not the latest is dropped. */
let probeToken = 0;

async function runProbe(path: string): Promise<void> {
  const mine = ++probeToken;
  probe.value = { state: 'checking', answeredFor: '', root: null };
  let next: { state: ProbeState; root: string | null };
  try {
    const result = await client.resolvePath(path);
    next = { state: result.openable ? 'openable' : 'not-a-repo', root: result.root };
  } catch (err) {
    // Any answer FROM the daemon means the path is not openable — a 400 for
    // a still-relative path (`~jorn/…`, and every keystroke of `~g…`) is the
    // common case. Only a dead transport is "unreachable"; calling a 400
    // that would claim the daemon is down while it is answering.
    next = { state: isTransportFailure(err) ? 'unreachable' : 'not-a-repo', root: null };
  }
  if (mine !== probeToken) return;
  probe.value = { ...next, answeredFor: path };
}

/** A DaemonError carries the daemon's own status; anything else (a fetch
 * rejection) never reached it. */
function isTransportFailure(err: unknown): boolean {
  return !(err instanceof Error && 'status' in err);
}

watch(trimmedQuery, (value) => {
  if (probeTimer !== null) clearTimeout(probeTimer);
  probeToken++;
  if (!/^[/~]/.test(value)) {
    probe.value = { state: 'idle', answeredFor: '', root: null };
    return;
  }
  probe.value = { state: 'checking', answeredFor: '', root: null };
  probeTimer = setTimeout(() => {
    probeTimer = null;
    void runProbe(value);
  }, PROBE_DEBOUNCE_MS);
});

onBeforeUnmount(() => {
  if (probeTimer !== null) clearTimeout(probeTimer);
});

function openTyped(): void {
  if (!canOpenTyped.value) return;
  // The ROOT the daemon told us it will open, not the typed string: for a
  // bare container they differ, and beginUserNav must record what actually
  // becomes active or the open replaces the history entry instead of
  // pushing one.
  void openPath(probe.value.root ?? trimmedQuery.value);
}

// --- Input ---------------------------------------------------------------

function onInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  openError.value = null;
  resetSelection();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    onEnter();
  } else if (event.key === 'Escape' && query.value !== '') {
    // Two-stage: clear first, close on the next Escape. stopPropagation is
    // load-bearing — useDismissable's handler sits on `document` and closes
    // on any Escape without checking defaultPrevented, so preventDefault
    // alone would clear the query AND close the panel. This handler runs in
    // the target phase, so stopping here means that listener never runs.
    event.preventDefault();
    event.stopPropagation();
    query.value = '';
    openError.value = null;
    resetSelection();
  }
}

function onEnter(): void {
  // The typed path wins only while the selection is untouched. Without
  // that, a path that the fuzzy filter also matches elsewhere (typing
  // `…/diffstalker` matches `diffstalker-git` as a subsequence) would let
  // the user arrow onto that row and have Enter open something else. The
  // rail and Enter must never disagree.
  if (!selectionMoved.value && pathLike.value) {
    if (canOpenTyped.value) {
      openTyped();
      return;
    }
    // Mid-probe: wait for the answer. Firing the raw path at POST /repos
    // instead would reintroduce the parent fallback the probe exists to
    // close, and open the wrong repo for a typo. 250ms is not worth that.
    if (probe.value.state === 'checking') return;
  }
  const row = selectedRow.value;
  if (row) chooseRow(row);
}

// --- Presentation --------------------------------------------------------

const connectionLost = computed(() => daemon.connection === 'disconnected');

const probeNote = computed(() => {
  if (!pathLike.value) return null;
  if (probe.value.state === 'checking') return 'checking path…';
  if (probe.value.answeredFor !== trimmedQuery.value) return null;
  if (probe.value.state === 'not-a-repo') return 'not a git repository';
  if (probe.value.state === 'unreachable') return 'could not reach daemon';
  return null;
});

function ageLabel(lastActivity: number | null): string {
  return lastActivity === null ? '' : formatRelativeTime(lastActivity);
}

/** Group a row path's characters into matched/unmatched runs. */
function segments(row: RepoRow): ReturnType<typeof toSegments> {
  return toSegments(row.path, row.positions);
}
</script>

<template>
  <div class="repo-picker" data-testid="repo-picker">
    <div class="input-row">
      <input
        ref="inputEl"
        class="picker-input mono"
        data-testid="picker-input"
        type="text"
        role="combobox"
        aria-label="Filter repositories, or type a path to open"
        :aria-expanded="options.length > 0"
        :aria-controls="options.length > 0 ? 'repo-picker-options' : undefined"
        :aria-activedescendant="
          selectedIndex >= 0 ? `repo-picker-option-${selectedIndex}` : undefined
        "
        placeholder="filter repos, or type a path"
        spellcheck="false"
        autocomplete="off"
        :value="query"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        v-if="canOpenTyped"
        type="button"
        class="open-btn chrome-chip"
        data-testid="picker-open-btn"
        :title="probe.root ?? undefined"
        @click="openTyped"
      >
        Open
      </button>
    </div>

    <p v-if="connectionLost" class="note mono" data-testid="picker-note">
      daemon connection lost — reconnecting…
    </p>
    <p v-else-if="openError" class="note error mono" data-testid="picker-note">{{ openError }}</p>
    <p v-else-if="probeNote" class="note mono" data-testid="picker-note">{{ probeNote }}</p>

    <p v-if="noMatches" class="note mono" data-testid="picker-no-matches">
      <template v-if="trimmedQuery === ''">no repositories yet</template>
      <template v-else>no repo matches “{{ trimmedQuery }}”</template>
    </p>

    <div
      v-else
      id="repo-picker-options"
      ref="listEl"
      class="options"
      role="listbox"
      aria-label="Repositories"
      data-testid="picker-options"
    >
      <template v-for="row in listRows" :key="row.key">
        <p v-if="row.kind === 'section'" class="group-label eyebrow">{{ row.label }}</p>

        <button
          v-else
          :id="`repo-picker-option-${options.indexOf(row)}`"
          class="picker-row"
          data-testid="picker-row"
          role="option"
          type="button"
          :aria-selected="row.key === selectedRow?.key"
          :class="{
            selected: row.key === selectedRow?.key,
            active: row.kind === 'open' && row.active,
            stale: row.kind === 'discovered' && row.stale,
          }"
          @mousemove="hover(row)"
          @click="chooseRow(row)"
        >
          <span class="name mono" :title="row.name">{{ row.name }}</span>
          <span
            v-if="row.kind !== 'discovered' && row.project.worktreeCount > 1"
            class="branch mono"
            >{{ row.project.worktreeCount }} worktrees</span
          >
          <span v-else-if="row.kind === 'discovered' && row.branch" class="branch mono">{{
            row.branch
          }}</span>
          <span class="meta mono">
            <span class="path" :title="row.path">
              <template v-for="(segment, si) in segments(row)" :key="si">
                <span v-if="segment.hit" class="hit">{{ segment.text }}</span>
                <template v-else>{{ segment.text }}</template>
              </template>
            </span>
            <span v-if="row.kind === 'discovered' && row.lastActivity" class="age">{{
              ageLabel(row.lastActivity)
            }}</span>
          </span>
        </button>
      </template>
    </div>

    <!-- Outside the listbox on purpose: an aria-activedescendant listbox may
         not contain tab stops, and a focusable button in there would take
         focus off the input, after which arrows and Escape stop arriving.
         It is still a synthetic last entry in the keyboard index.

         mousedown.prevent for the same reason from the other direction:
         this is the one row a mouse can press without the picker closing
         straight after, so without it a click parks focus on the button
         and the next Escape reaches the popover instead of the query. -->
    <button
      v-if="moreRow"
      type="button"
      class="more-row mono"
      data-testid="picker-more"
      :class="{ selected: moreRow.key === selectedRow?.key }"
      @mousedown.prevent
      @mousemove="hover(moreRow)"
      @click="chooseRow(moreRow)"
    >
      {{ moreRow.label }}
    </button>

    <p class="hints mono" aria-hidden="true">
      <kbd>↑↓</kbd> move · <kbd>enter</kbd> open · <kbd>esc</kbd> {{ trimmedQuery ? 'clear' : 'close' }}
    </p>
  </div>
</template>

<style scoped>
.repo-picker {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-width: 0;
}

.input-row {
  display: flex;
  gap: 0.5rem;
}

.picker-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-base);
}

.open-btn {
  padding: 0.375rem 0.875rem;
  white-space: nowrap;
}

.open-btn:hover {
  border-color: var(--accent);
}

.note {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.note.error {
  color: var(--del);
}

/* The list scrolls, the input does not: with 60-odd repos revealed, a panel
   that grew instead would push its own input off the top of the screen.
   Matches WorktreeSwitcher, the sibling popover. */
.options {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  max-height: 60vh;
  overflow-y: auto;
}

.group-label {
  margin: 0.375rem 0 0.125rem;
}

.group-label:first-child {
  margin-top: 0;
}

.picker-row {
  display: grid;
  /* minmax(0, 1fr), NOT 1fr: a bare 1fr floors at the name's min-content, so
     a long hyphenated name wraps hyphen-by-hyphen into a tall column while
     the branch keeps its width. Flooring at 0 lets the name ellipsize. */
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 0.5rem;
  padding: 0.375rem 0.5rem 0.375rem calc(0.5rem - var(--row-rail));
  border-left: var(--row-rail) solid transparent;
  border-radius: 4px;
  text-align: left;
}

/* Hover IS selection (@mousemove sets it), so there is no separate hover
   background — that would light a row the keyboard has moved away from. */
.picker-row.selected {
  background: var(--row-selected-bg);
  border-left-color: var(--selection);
}

/* Two different facts, two different colours, never conflated: the rail
   marks where the keyboard is, the accent marks which repo is active. */
.picker-row.active .name {
  color: var(--accent);
}

/* A project nobody has touched in half a year is still listed, in its place,
   but it stops shouting: the name drops to the dim weight the path uses. */
.picker-row.stale .name {
  font-weight: 500;
  color: var(--text-dim);
}

.picker-row.stale:hover .name {
  color: var(--text);
}

.name {
  font-size: var(--fs-base);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch {
  font-size: var(--fs-small);
  color: var(--text-dim);
  justify-self: end;
  /* Capped so a long branch cannot starve the name column. */
  max-width: 12rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Path and age share the row's second line: the PATH gives way (it is the
   least surprising thing on the row), the age never does. */
.meta {
  grid-column: 1 / -1;
  display: flex;
  gap: 0.375rem;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--text-dim);
}

.meta .path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit {
  color: var(--warn);
  font-weight: 600;
}

.age {
  flex: none;
}

.more-row {
  margin-top: 0.25rem;
  padding: 0.375rem 0.5rem 0.375rem calc(0.5rem - var(--row-rail));
  border-top: 1px solid var(--border);
  border-left: var(--row-rail) solid transparent;
  border-radius: 4px;
  text-align: left;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.more-row:hover,
.more-row.selected {
  color: var(--text);
  background: var(--surface-raised);
}

.more-row.selected {
  border-left-color: var(--selection);
}

.hints {
  margin: 0.125rem 0 0;
  color: var(--text-dim);
  font-size: var(--fs-micro);
}
</style>
