<script setup lang="ts">
/**
 * ImageView: the Explorer's picture viewer — the working-tree side of one
 * selected file, rendered in an ImageFrame with a 1:1 toggle.
 *
 * Self-contained like WrapToggle and ViewFileButton: it reads the repo store
 * for the id itself instead of taking it as a prop, so FileContentPane hands
 * it only what it already has (the path and the daemon's media verdict).
 *
 * There is deliberately NO "open raw", "view original" or "download anyway"
 * link here or anywhere else. Such a link is the exact threat this whole
 * design exists to prevent: it is a TOP-LEVEL NAVIGATION to repo bytes on
 * the daemon's own origin, which turns every same-origin protection into a
 * formality. Bytes reach the page only as an `<img src>` subresource; the
 * /blob route enforces that with a Sec-Fetch-Dest guard, so such a link
 * would not even work. Its absence is a feature — do not add one back.
 *
 * No zoom or pan gestures either. Every gesture they would need is already
 * claimed: the wheel scrolls the page, dragging is SplitResizer's and text
 * selection's, and pinch is the portrait band swipe in usePortraitKeys.
 * `fit` (shrink, never upscale) plus `actual` over the stage's native
 * overflow covers the real use with no event handlers at all.
 */

import { computed, ref } from 'vue';
import type { FileMedia } from '@diffstalker/client';
import { useRepoStore } from '../stores/repo';
import { blobUrl } from '../api/client';
import ImageFrame from './ImageFrame.vue';

const props = defineProps<{
  /** Repo-relative path of the selected file. */
  path: string;
  /** The daemon's verdict. Only mounted when media.image is non-null. */
  media: FileMedia;
}>();

const emit = defineEmits<{ fail: [] }>();

const repo = useRepoStore();

/**
 * A per-session preference, never persisted, and deliberately NOT keyed off
 * the path: someone comparing two screenshots at 1:1 should not have to
 * press the toggle again for each one.
 */
const fit = ref<'fit' | 'actual'>('fit');

/**
 * The Explorer always shows the file as it is on disk, so the side is always
 * `worktree`. `version` is the daemon's cache key (size-mtime here), which is
 * what makes the browser refetch when the file changes on disk.
 */
const src = computed(() =>
  repo.repoId === null
    ? null
    : blobUrl(repo.repoId, { path: props.path, side: 'worktree', version: props.media.version })
);
</script>

<template>
  <!-- No repo means no selected file, so the null src is a single tear-down
       tick during a repo switch. Rendering an empty src instead would make
       the browser request the DOCUMENT's own URL as an image. -->
  <div v-if="src !== null && media.image" class="image-view" data-testid="image-view">
    <div class="image-controls">
      <button
        class="fit-toggle mono"
        data-testid="image-fit-toggle"
        :class="{ on: fit === 'actual' }"
        :aria-pressed="fit === 'actual'"
        aria-label="Show the image at its actual size"
        :title="
          fit === 'actual'
            ? 'Actual size: on. Click to shrink the image to fit'
            : 'Actual size: off. Click to show every pixel 1:1 and scroll'
        "
        @click="fit = fit === 'actual' ? 'fit' : 'actual'"
      >
        1:1
      </button>
    </div>

    <ImageFrame
      :src="src"
      :width="media.image.width"
      :height="media.image.height"
      :fit="fit"
      @fail="emit('fail')"
    />
  </div>
</template>

<style scoped>
.image-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.image-controls {
  flex: none;
  display: flex;
  justify-content: flex-end;
  padding: 0.25rem 0.5rem;
}

/* Same low-key shape as WrapToggle: an occasional preference, not an
   app-wide mode, so it must not compete with the header's own toggles. */
.fit-toggle {
  flex: none;
  padding: 0.125rem 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  font-size: var(--fs-micro);
  color: var(--text-dim);
  background: transparent;
}

.fit-toggle:hover {
  color: var(--text);
  border-color: var(--border);
}

.fit-toggle.on {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}

.image-view :deep(.image-frame) {
  flex: 1;
}
</style>
