<script setup lang="ts">
/**
 * ImageFrame: the one place in the app that puts repo bytes on screen.
 *
 * A checkerboard stage plus exactly ONE `<img>`. Store-free and prop-driven
 * so both viewers (the Explorer's ImageView and, later, the diff's
 * ImageDiffView) share a single copy of the rules below.
 *
 * How the bytes get here. Only as `<img src="/repos/:id/blob?…">` — a
 * relative, same-origin URL the browser fetches itself. Nothing in this
 * package ever reads those bytes: no fetch().blob(), no arrayBuffer(), no
 * URL.createObjectURL, no data: URI, no canvas. That is not an
 * implementation detail, it is the security design: the browser's sandboxed,
 * auto-updated image decoder is where hostile bytes belong, and a blob: URL
 * would inherit this document's origin. The CSP has no `blob:` for the same
 * reason.
 *
 * Why the state machine. A failed decode must leave NOTHING behind:
 *
 *  - `loading` and `ok` keep the same `<img>` element (swapping elements
 *    would restart the fetch); `visibility: hidden` until `ok` is what stops
 *    the browser's broken-image glyph from flashing while it decodes.
 *  - `failed` removes the `<img>` from the DOM entirely. `visibility` alone
 *    is not enough — a hidden broken image still reserves its alt text for
 *    a screen reader, and the alt text is the only string we control here.
 *
 * `alt` is a STATIC constant, never the repo path. A path is repo-controlled
 * text; the header above the frame already shows it (with a `title`), and
 * that is the one place it belongs.
 *
 * Why @load can still fail. A `load` with `naturalWidth === 0` means the
 * decoder produced no pixels. This is NOT a security control and must never
 * be read as one — the daemon re-sniffs the exact bytes it is about to write
 * on every single request, which is what closes the time-of-check gap. Nor
 * do we compare against the dimensions the /media verdict reported: a JPEG
 * with an EXIF orientation of 5-8 decodes transposed, so an honest image
 * would fail an equality check.
 */

import { ref, watch } from 'vue';

const props = defineProps<{
  /** Same-origin blob URL. Built by blobUrl() — never assembled inline. */
  src: string;
  /** Intrinsic size from the daemon's verdict: reserves the box before decode. */
  width: number;
  height: number;
  /** 'fit' shrinks to the stage and never upscales; 'actual' is exactly 1:1. */
  fit: 'fit' | 'actual';
}>();

const emit = defineEmits<{ ok: []; fail: [] }>();

/** The one label the frame exposes. Deliberately not the repo path. */
const ALT = 'Image preview';

const state = ref<'loading' | 'ok' | 'failed'>('loading');

// A new src is a new image: back to loading, so a previously failed frame
// gets a real chance and a previously loaded one does not paint stale pixels
// under a fresh URL.
watch(
  () => props.src,
  () => {
    state.value = 'loading';
  }
);

function onLoad(event: Event): void {
  const img = event.target as HTMLImageElement;
  if (img.naturalWidth === 0 || img.naturalHeight === 0) {
    onError();
    return;
  }
  state.value = 'ok';
  emit('ok');
}

function onError(): void {
  state.value = 'failed';
  emit('fail');
}
</script>

<template>
  <div
    class="image-frame"
    :class="fit"
    data-testid="image-frame"
    tabindex="0"
    role="group"
    aria-label="Image preview"
  >
    <img
      v-if="state !== 'failed'"
      class="image"
      :class="{ ready: state === 'ok' }"
      data-testid="image"
      :src="src"
      :width="width"
      :height="height"
      :alt="ALT"
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      draggable="false"
      @load="onLoad"
      @error="onError"
    />

    <p v-if="state === 'loading'" class="frame-note" data-testid="image-loading">Loading…</p>
    <p v-else-if="state === 'failed'" class="frame-note" data-testid="image-failed">
      Preview failed to decode
    </p>
  </div>
</template>

<style scoped>
/* The checkerboard is what tells transparent from white — without it a PNG
   with an alpha channel is indistinguishable from one painted on the card. */
.image-frame {
  min-width: 0;
  min-height: 0;
  display: grid;
  /* `safe` is load-bearing: with plain `center`, an image wider than the
     stage overflows in BOTH directions and its top-left corner becomes
     unreachable by scrolling. `safe` falls back to start-alignment exactly
     when the content overflows, which is what makes 1:1 pannable. */
  place-items: safe center;
  overflow: auto;
  background-color: var(--checker-a);
  background-image:
    linear-gradient(
      45deg,
      var(--checker-b) 25%,
      transparent 25%,
      transparent 75%,
      var(--checker-b) 75%
    ),
    linear-gradient(
      45deg,
      var(--checker-b) 25%,
      transparent 25%,
      transparent 75%,
      var(--checker-b) 75%
    );
  background-size: var(--checker-size) var(--checker-size);
  background-position:
    0 0,
    calc(var(--checker-size) / 2) calc(var(--checker-size) / 2);
}

/* Hidden, not absent: the element must stay in the DOM while it decodes or
   the fetch restarts. visibility (unlike display:none) keeps the reserved
   box, so nothing jumps when the pixels arrive. */
.image {
  visibility: hidden;
  grid-area: 1 / 1;
}

.image.ready {
  visibility: visible;
}

/* Shrink to fit, never upscale: a 16x16 favicon stays 16x16 instead of
   becoming a blurry poster. */
.image-frame.fit .image {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
}

/* Exactly 1:1. The stage's own overflow:auto gives pan for free — no
   gesture handling, no wheel hijacking. */
.image-frame.actual .image {
  max-width: none;
  max-height: none;
}

.frame-note {
  grid-area: 1 / 1;
  margin: 0;
  padding: 1rem;
  color: var(--text-dim);
  font-size: var(--fs-small);
  text-align: center;
}
</style>
