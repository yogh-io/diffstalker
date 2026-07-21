<script lang="ts">
/**
 * DiffChurnHarness: DEV-ONLY soak rig for the scroll-anchoring sandwich
 * (docs/web-diff-stream-architecture.md, section 9 risk #1). Never part
 * of the production bundle — main.ts mounts it instead of App only when
 * import.meta.env.DEV and the URL carries `harness=diff`:
 *
 *   http://localhost:5173/?harness=diff
 *
 * It mounts the REAL DiffStack over a synthetic reactive file set and
 * churns it every ~400ms — modifying hunks, adding/removing hunks, and
 * occasionally adding/removing whole files — through the real
 * parseDiffWithLineNumbers + buildDiffModel pipeline, so stable keys
 * behave exactly as in production. Unchanged entries keep their
 * StackFile and DiffResult object identity (the store's identity
 * preservation, reproduced here), so only churned sections patch.
 *
 * The verdict is the layout-shift readout: a PerformanceObserver sums
 * `layout-shift` entries with hadRecentInput === false whose source
 * rects intersect the scroller. Under churn it MUST read 0 — any
 * nonzero value is a sandwich bug. "Scroll to middle + churn above"
 * parks the viewport mid-stack and aims the next 10 ops exclusively at
 * files fully above it: the hardest case, where every height change
 * must be compensated.
 */

import { parseDiffWithLineNumbers } from '@diffstalker/core/git/diffParse';
import type { DiffResult } from '@diffstalker/core/git/diff';
import type { StackFile } from '../components/DiffStack.vue';

interface FakeHunk {
  /** Stable id — feeds the stable @@ context, so the hunk key survives churn. */
  id: number;
  /** Stable old-side start — the other half of the hunk key identity. */
  oldStart: number;
  /** Changed-line pairs in the hunk body. */
  body: number;
  /** Bumped on modify: rewrites the + lines' content, keys untouched. */
  rev: number;
}

interface FakeFile {
  path: string;
  hunks: FakeHunk[];
}

interface Entry {
  fake: FakeFile;
  stack: StackFile;
}

function randInt(min: number, max: number): number {
  // Dev harness only: Math.random is exactly right for churn fuzzing.
  // eslint-disable-next-line sonarjs/pseudo-random
  return min + Math.floor(Math.random() * (max - min + 1));
}

let nextHunkId = 1;

function makeHunk(): FakeHunk {
  return { id: nextHunkId++, oldStart: randInt(1, 900), body: randInt(1, 6), rev: 0 };
}

function sortHunks(hunks: FakeHunk[]): void {
  hunks.sort((a, b) => a.oldStart - b.oldStart || a.id - b.id);
}

function makeFake(path: string, hunkCount: number): FakeFile {
  const hunks = Array.from({ length: hunkCount }, makeHunk);
  sortHunks(hunks);
  return { path, hunks };
}

/** Render the fake file as a real unified diff and parse it for real. */
function renderDiff(file: FakeFile): DiffResult {
  const out: string[] = [
    `diff --git a/${file.path} b/${file.path}`,
    'index 0000000..1111111 100644',
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
  ];
  for (const h of file.hunks) {
    // 2 context lines + body dels / body adds on each side.
    out.push(`@@ -${h.oldStart},${h.body + 2} +${h.oldStart},${h.body + 2} @@ fn_${h.id}()`);
    out.push(` context before fn_${h.id}`);
    for (let k = 0; k < h.body; k++) out.push(`-  old line ${h.id}.${k}`);
    for (let k = 0; k < h.body; k++) out.push(`+  new line ${h.id}.${k} rev${h.rev}`);
    out.push(` context after fn_${h.id}`);
  }
  const raw = out.join('\n') + '\n';
  return { raw, lines: parseDiffWithLineNumbers(raw) };
}

function toStack(fake: FakeFile): StackFile {
  const changed = fake.hunks.reduce((sum, h) => sum + h.body, 0);
  return {
    key: `u:${fake.path}`,
    path: fake.path,
    status: 'modified',
    stats: { insertions: changed, deletions: changed },
    diff: renderDiff(fake),
  };
}

/** Minimal layout-shift entry types (not in lib.dom). */
interface LayoutShiftAttribution {
  previousRect: DOMRectReadOnly;
  currentRect: DOMRectReadOnly;
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources?: LayoutShiftAttribution[];
}

function rectsIntersect(a: DOMRectReadOnly, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import DiffStack from '../components/DiffStack.vue';

const CHURN_INTERVAL_MS = 400;
const ABOVE_BURST_OPS = 10;
const MIN_FILES = 3;
const MAX_FILES = 14;

/** The mutable world; `files` republishes it, reusing untouched objects. */
let model: Entry[] = Array.from({ length: 8 }, (_, i) => {
  const fake = makeFake(`src/gen/file_${i}.ts`, randInt(2, 5));
  return { fake, stack: toStack(fake) };
});
let nextFileNo = model.length;

const files = shallowRef<StackFile[]>(model.map((e) => e.stack));
const running = ref(true);
const commitCount = ref(0);
const lastOp = ref('—');
const clsTotal = ref(0);
const shiftCount = ref(0);
const clsSupported = ref(true);
/** Remaining ops forced onto files fully above the viewport. */
let aboveBurst = 0;

const stackRef = ref<InstanceType<typeof DiffStack> | null>(null);

function getScroller(): HTMLElement | null {
  return (stackRef.value?.scrollerEl as HTMLElement | null) ?? null;
}

function publish(op: string): void {
  files.value = model.map((e) => e.stack);
  commitCount.value++;
  lastOp.value = op;
}

/** Recompute one entry's diff + stats; every other entry keeps identity. */
function commitEntry(index: number): void {
  const entry = model[index];
  model = model.slice();
  model[index] = { fake: entry.fake, stack: { ...entry.stack, ...toStack(entry.fake) } };
}

/** Indices of files whose section sits FULLY above the scrolled viewport. */
function aboveIndices(): number[] {
  const scroller = getScroller();
  if (!scroller) return [];
  const sections = scroller.querySelectorAll<HTMLElement>('[data-testid="file-diff"]');
  const out: number[] = [];
  sections.forEach((el, i) => {
    if (i < model.length && el.offsetTop + el.offsetHeight < scroller.scrollTop) out.push(i);
  });
  return out;
}

function pickIndex(above: boolean): number {
  if (above) {
    const candidates = aboveIndices();
    if (candidates.length > 0) return candidates[randInt(0, candidates.length - 1)];
  }
  return randInt(0, model.length - 1);
}

function churnTick(): void {
  const above = aboveBurst > 0;
  if (above) aboveBurst--;
  const index = pickIndex(above);
  const entry = model[index];
  const where = above ? ' (above viewport)' : '';
  // eslint-disable-next-line sonarjs/pseudo-random -- dev-only fuzzing
  const roll = Math.random();

  if (roll < 0.5) {
    // Modify: rewrite one hunk's added lines; hunk key survives.
    const hunk = entry.fake.hunks[randInt(0, entry.fake.hunks.length - 1)];
    hunk.rev++;
    commitEntry(index);
    publish(`modify hunk fn_${hunk.id} in ${entry.fake.path}${where}`);
  } else if (roll < 0.68) {
    const hunk = makeHunk();
    entry.fake.hunks.push(hunk);
    sortHunks(entry.fake.hunks);
    commitEntry(index);
    publish(`add hunk fn_${hunk.id} to ${entry.fake.path}${where}`);
  } else if (roll < 0.84 || (above && model.length <= MIN_FILES)) {
    if (entry.fake.hunks.length > 1) {
      const [removed] = entry.fake.hunks.splice(randInt(0, entry.fake.hunks.length - 1), 1);
      commitEntry(index);
      publish(`remove hunk fn_${removed.id} from ${entry.fake.path}${where}`);
    } else {
      const hunk = entry.fake.hunks[0];
      hunk.rev++;
      commitEntry(index);
      publish(`modify hunk fn_${hunk.id} in ${entry.fake.path}${where}`);
    }
  } else if (roll < 0.92 && model.length < MAX_FILES) {
    // Whole-file insert — during an above-burst, insert ABOVE the viewport.
    const fake = makeFake(`src/gen/new_${nextFileNo++}.ts`, randInt(1, 4));
    const at = above ? Math.min(index, model.length) : randInt(0, model.length);
    model = model.slice();
    model.splice(at, 0, { fake, stack: toStack(fake) });
    publish(`add file ${fake.path} at ${at}${where}`);
  } else if (model.length > MIN_FILES) {
    model = model.slice();
    const [removed] = model.splice(index, 1);
    publish(`remove file ${removed.fake.path}${where}`);
  } else {
    commitEntry(index);
    publish(`refresh ${entry.fake.path}${where}`);
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;

function startChurn(): void {
  if (ticker === null) ticker = setInterval(churnTick, CHURN_INTERVAL_MS);
  running.value = true;
}

function stopChurn(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
  running.value = false;
}

function toggleChurn(): void {
  if (running.value) stopChurn();
  else startChurn();
}

function scrollMiddleChurnAbove(): void {
  const scroller = getScroller();
  if (!scroller) return;
  scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
  aboveBurst = ABOVE_BURST_OPS;
  startChurn();
}

function resetCounters(): void {
  clsTotal.value = 0;
  shiftCount.value = 0;
}

let shiftObserver: PerformanceObserver | null = null;

onMounted(() => {
  // The harness renders standalone (no App, no ui store), so stamp the
  // theme attribute the generated stylesheet keys on.
  document.documentElement.dataset.theme ??= 'dark';

  try {
    shiftObserver = new PerformanceObserver((list) => {
      const region = getScroller()?.getBoundingClientRect();
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        if (entry.hadRecentInput) continue; // user-input shifts are legit
        // Attribute to the scroller region when sources exist; entries
        // without attribution are counted anyway (conservative).
        if (
          region &&
          entry.sources?.length &&
          !entry.sources.some(
            (s) => rectsIntersect(s.currentRect, region) || rectsIntersect(s.previousRect, region)
          )
        ) {
          continue;
        }
        clsTotal.value += entry.value;
        shiftCount.value++;
      }
    });
    shiftObserver.observe({ type: 'layout-shift', buffered: true });
  } catch {
    clsSupported.value = false; // e.g. Firefox: no layout-shift entries
  }

  startChurn();
});

onBeforeUnmount(() => {
  stopChurn();
  shiftObserver?.disconnect();
});
</script>

<template>
  <div class="harness">
    <header class="controls mono">
      <strong>DiffStack churn harness</strong>
      <button @click="toggleChurn">{{ running ? 'pause churn' : 'resume churn' }}</button>
      <button @click="scrollMiddleChurnAbove">scroll to middle + churn above ×10</button>
      <button @click="resetCounters">reset counters</button>
      <span
        v-if="clsSupported"
        class="readout"
        :class="clsTotal === 0 ? 'pass' : 'fail'"
        data-testid="cls-readout"
      >
        layout-shift Σ {{ clsTotal.toFixed(4) }} · {{ shiftCount }} entries ·
        {{ clsTotal === 0 ? 'PASS' : 'FAIL' }}
      </span>
      <span v-else class="readout fail">layout-shift unsupported in this browser</span>
      <span class="meta">commits {{ commitCount }} · files {{ files.length }}</span>
      <span class="meta op">{{ lastOp }}</span>
    </header>
    <DiffStack ref="stackRef" class="stack" :files="files" />
  </div>
</template>

<style scoped>
.harness {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
}

.controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-small);
}

.controls button {
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface-raised);
  color: var(--text);
  cursor: pointer;
}

.controls button:hover {
  border-color: var(--accent);
}

.readout.pass {
  color: var(--add);
}

.readout.fail {
  color: var(--del);
  font-weight: 700;
}

.meta {
  color: var(--text-dim);
}

.op {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stack {
  flex: 1;
  min-height: 0;
}
</style>
