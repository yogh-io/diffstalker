<script setup lang="ts">
/**
 * ImageDiffView: the picture card inside a Changes section — the old and
 * new sides of one changed image, compared three ways.
 *
 * THE META BAR IS NOT DECORATION. It always shows both byte sizes and both
 * short oids, and it says so out loud when the dimensions match but the
 * bytes do not. Two images can be pixel-identical and still differ: EXIF
 * (GPS coordinates, a camera serial number, an embedded thumbnail showing
 * something else entirely) or an ICC profile. Stripping metadata
 * server-side would need a decoder, and decoding hostile bytes in the
 * daemon is vetoed by the design. So the numbers carry what the picture
 * cannot: a reviewer must never be able to look at this card and conclude
 * "nothing changed" when something did.
 *
 * Three modes, all CSS, no canvas:
 *  - side by side (the default, and the ONLY correct mode when the two
 *    sides differ in size — a wipe or a fade between differently-shaped
 *    images compares nothing);
 *  - swipe: both frames stacked, the new one clipped by a clip-path inset
 *    the range input drives;
 *  - onion: the same stack, the new one's opacity driven by that range.
 * Canvas is deliberately absent: a difference blend or a pixel heatmap
 * needs getContext('2d'), which forces decoded buffers into the JS heap —
 * and happy-dom returns null for it, so none of it could be tested.
 *
 * FIXED HEIGHT IN EVERY STATE. Three strips (meta, frame, controls) sized
 * from CSS variables, in loading, loaded, failed and one-sided alike. That
 * is not styling: DiffStack memoizes ONE height for this slot and reuses
 * it for every section it has not measured, so a card that changed height
 * with its state would desync every section offset below it. It is also
 * better to read — every image card is the same size, and a 4000x3000
 * screenshot cannot swallow the viewport.
 *
 * No "open raw", "view original" or "download anyway" here either. See
 * ImageView's module comment: that link IS the top-level-navigation threat
 * the whole design exists to prevent.
 */

import { computed, ref, watch } from 'vue';
import type { MediaPair, MediaSide } from '@diffstalker/client';
import { blobUrl } from '../api/client';
import { formatBytes } from '../utils/format';
import { refusalSentence } from '../utils/imageRefusal';
import { useUiStore } from '../stores/ui';
import type { ImageDiffMode } from '../prefs';
import ImageFrame from './ImageFrame.vue';

const props = defineProps<{
  pair: MediaPair;
  /** Passed in, not read from the store: the card is rendered in a
   * v-for and must use the id the section was built from. */
  repoId: string;
}>();

/** Emitted when NEITHER side can be shown: the parent falls back to the note. */
const emit = defineEmits<{ fail: [] }>();

const ui = useUiStore();

const MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'swipe', label: 'Swipe' },
  { value: 'onion', label: 'Onion' },
];

/**
 * One slider for both overlay modes: 0 is all old, 100 is all new. Kept
 * component-local — it is a gesture, not a preference, and it means
 * nothing once you look away from this file.
 */
const mix = ref(50);

/** A side is renderable only when the daemon produced an image verdict. */
function renderable(side: MediaSide | null): boolean {
  return side !== null && side.image !== null;
}

const hasOld = computed(() => renderable(props.pair.old));
const hasNew = computed(() => renderable(props.pair.new));

/**
 * Overlay modes need two pictures of the SAME shape to mean anything, so
 * they degrade to side by side otherwise. Degrading here rather than
 * disabling the buttons keeps the reader's app-wide choice intact: the
 * next image that can honour it, does.
 */
const sameShape = computed(() => {
  const a = props.pair.old?.image;
  const b = props.pair.new?.image;
  return !!a && !!b && a.width === b.width && a.height === b.height;
});

const mode = computed<ImageDiffMode>(() =>
  ui.imageDiffMode !== 'side-by-side' && hasOld.value && hasNew.value && sameShape.value
    ? ui.imageDiffMode
    : 'side-by-side'
);

/** The slider only drives something in an overlay mode over two frames. */
const sliderActive = computed(() => mode.value !== 'side-by-side');

const stageStyle = computed(() => ({
  '--swipe': String(mix.value),
  '--onion': String(mix.value / 100),
}));

function srcFor(side: MediaSide): string {
  return blobUrl(props.repoId, { path: side.path, side: side.side, version: side.version });
}

// --- Per-side decode failures ---

/**
 * The browser refused bytes the daemon accepted. Only that half swaps to
 * a plate: the other side is a different blob and may be perfectly fine.
 * Reset whenever the pair changes — a new blob deserves its own attempt.
 */
const oldFailed = ref(false);
const newFailed = ref(false);

watch(
  () => props.pair,
  () => {
    oldFailed.value = false;
    newFailed.value = false;
  }
);

/** Nothing left to show on either side: the section falls back to the note. */
watch([oldFailed, newFailed], () => {
  const oldGone = !hasOld.value || oldFailed.value;
  const newGone = !hasNew.value || newFailed.value;
  if (oldGone && newGone) emit('fail');
});

// --- Meta bar ---

/** `24.0 KB · 512 × 512 · a1b2c3d` — U+00D7, and a 7-char oid like git. */
function describe(side: MediaSide | null): string {
  if (side === null) return '—';
  const parts = [formatBytes(side.bytes)];
  if (side.image) parts.push(`${side.image.width} × ${side.image.height}`);
  // The working tree is not a git object, so it has no oid to name.
  parts.push(side.oid === null ? 'working tree' : side.oid.slice(0, 7));
  return parts.join(' · ');
}

const oldMeta = computed(() => describe(props.pair.old));
const newMeta = computed(() => describe(props.pair.new));

/** Signed byte delta, only when both sides really have bytes. */
const byteDelta = computed(() => {
  const a = props.pair.old?.bytes;
  const b = props.pair.new?.bytes;
  if (a === undefined || b === undefined || a === b) return null;
  return `${b > a ? '+' : '−'}${formatBytes(Math.abs(b - a))}`;
});

/**
 * The hint that stops "the pictures look the same, so nothing changed".
 * Same dimensions and different bytes is exactly the EXIF/ICC case.
 */
const metadataOnly = computed(() => sameShape.value && byteDelta.value !== null);

/** Why a side shows a plate instead of a picture. */
function plateText(side: MediaSide | null, failed: boolean): string {
  if (side === null) return 'No version on this side';
  if (failed) return 'Preview failed to decode';
  return refusalSentence(side.refusal);
}
</script>

<template>
  <div class="image-diff" :class="mode" data-testid="image-diff">
    <p class="image-meta mono" data-testid="image-meta">
      <span class="side-meta">old {{ oldMeta }}</span>
      <span class="arrow" aria-hidden="true">→</span>
      <span class="side-meta">new {{ newMeta }}</span>
      <span v-if="byteDelta" class="delta" data-testid="image-byte-delta">({{ byteDelta }})</span>
      <span v-if="metadataOnly" class="hint" data-testid="image-metadata-hint">
        same dimensions, different bytes — the change may be metadata only (EXIF/ICC)
      </span>
    </p>

    <div class="image-stage" :class="mode" :style="stageStyle">
      <div class="half old" data-testid="image-old">
        <ImageFrame
          v-if="pair.old && pair.old.image && !oldFailed"
          :src="srcFor(pair.old)"
          :width="pair.old.image.width"
          :height="pair.old.image.height"
          fit="fit"
          @fail="oldFailed = true"
        />
        <p v-else class="plate" data-testid="image-refused">
          {{ plateText(pair.old, oldFailed) }}
        </p>
      </div>
      <div class="half new" data-testid="image-new">
        <ImageFrame
          v-if="pair.new && pair.new.image && !newFailed"
          :src="srcFor(pair.new)"
          :width="pair.new.image.width"
          :height="pair.new.image.height"
          fit="fit"
          @fail="newFailed = true"
        />
        <p v-else class="plate" data-testid="image-refused">
          {{ plateText(pair.new, newFailed) }}
        </p>
      </div>
    </div>

    <div class="image-controls">
      <div
        class="mode-picker"
        role="radiogroup"
        aria-label="Image comparison mode"
        data-testid="image-diff-mode"
      >
        <button
          v-for="entry in MODES"
          :key="entry.value"
          class="mode-btn mono"
          :class="{ on: ui.imageDiffMode === entry.value }"
          role="radio"
          :aria-checked="ui.imageDiffMode === entry.value"
          :data-mode="entry.value"
          @click="ui.setImageDiffMode(entry.value)"
        >
          {{ entry.label }}
        </button>
      </div>
      <!-- Kept in the DOM, only hidden, whenever it cannot drive anything
           (side by side, or a one-sided change): removing it would change
           the card's height, and this card's height is a constant the
           stack's offset model depends on. -->
      <input
        v-model.number="mix"
        class="swipe-range"
        :class="{ inert: !sliderActive }"
        data-testid="image-diff-swipe"
        type="range"
        min="0"
        max="100"
        step="1"
        aria-label="Swipe between old and new"
        :disabled="!sliderActive"
      />
    </div>
  </div>
</template>

<style scoped>
/* The three strips. Fixed rows, not content-driven: DiffStack memoizes one
   height for this whole card (see the module comment) and every state —
   loading, loaded, failed, one-sided — must land on exactly this height. */
.image-diff {
  display: grid;
  grid-template-rows: var(--image-meta-h) minmax(0, 1fr) var(--image-controls-h);
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.image-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  margin: 0;
  padding: 0 0.75rem;
  overflow: hidden;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: var(--fs-small);
}

.side-meta {
  flex: none;
}

.arrow,
.delta {
  flex: none;
}

/* The one part of the bar allowed to be cut off when the card is narrow:
   the numbers beside it already carry the fact. */
.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--warn);
}

.image-stage {
  min-height: 0;
  overflow: hidden;
}

.image-stage.side-by-side {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: var(--border);
}

/* Both overlay modes stack the halves in one box. */
.image-stage.swipe,
.image-stage.onion {
  display: grid;
}

.image-stage.swipe .half,
.image-stage.onion .half {
  grid-area: 1 / 1;
}

.half {
  min-width: 0;
  min-height: 0;
  display: flex;
}

.half :deep(.image-frame) {
  flex: 1;
  min-width: 0;
}

/* Swipe: the new side is revealed from the left as the slider travels. */
.image-stage.swipe .half.new {
  clip-path: inset(0 0 0 calc(var(--swipe) * 1%));
}

/* Onion: the new side fades in over the old one. */
.image-stage.onion .half.new {
  opacity: var(--onion);
}

.plate {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0.75rem;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--fs-small);
  background: var(--surface);
}

.image-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0 0.75rem;
  overflow: hidden;
}

.mode-picker {
  flex: none;
  display: flex;
  gap: 0.25rem;
}

.mode-btn {
  padding: 0.125rem 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--text-dim);
  background: transparent;
  font-size: var(--fs-micro);
  cursor: pointer;
}

.mode-btn:hover {
  color: var(--text);
  border-color: var(--border);
}

.mode-btn.on {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}

.swipe-range {
  flex: 1;
  min-width: 0;
}

/* Hidden, never removed: the card's height is a constant elsewhere. */
.swipe-range.inert {
  visibility: hidden;
}
</style>
