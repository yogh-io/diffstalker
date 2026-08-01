<script setup lang="ts">
/**
 * FileContentPane: the Explorer's read-only code viewer — path/size
 * header plus syntax-highlighted content with line numbers.
 *
 * All display states come from the daemon's FileForDisplay FLAGS (never
 * parsed out of content): binary, tooLarge, truncated (content cut at
 * the daemon's line cap; the note quotes totalLines), empty file, and
 * the no-selection prompt.
 *
 * Highlighting: utils/highlight (highlight.js common build) returns
 * per-line HTML that is escaped on every path and span-balanced per
 * line, so v-html here is safe by construction. Token colors are the
 * per-theme --syn-* vars — the :deep block below is the single
 * hljs-class → token-var mapping.
 *
 * Large files: same virtualization trick as DiffView — every line row
 * carries content-visibility:auto with an intrinsic-size estimate, so
 * a 5000-line file costs layout only for what's on screen.
 *
 * Images: a file whose media verdict carries an `image` renders in
 * ImageView instead of the binary note. That branch sits ABOVE both the
 * binary and the tooLarge branches on purpose — the 1 MiB tooLarge flag
 * is the TEXT cap, and below the image branch every picture over it
 * would read "File too large" instead of simply showing.
 *
 * There is deliberately NO "open raw", "view original" or "download
 * anyway" link on any of these states. Such a link is a top-level
 * navigation to repo bytes on the daemon's origin — the exact threat the
 * image feature is built to avoid (see ImageView's module comment).
 * Bytes reach the page only as an `<img src>` subresource.
 */

import { computed, ref, watch } from 'vue';
import type { FileForDisplay } from '@diffstalker/core/git/explorerData';
import { REFUSAL_TEXT } from '../utils/imageRefusal';
import { highlightContent } from '../utils/highlight';
import { formatBytes } from '../utils/format';
import WrapToggle from './WrapToggle.vue';
import ImageView from './ImageView.vue';

const props = defineProps<{
  /** Repo-relative path of the selected file; null = nothing selected. */
  path: string | null;
  file: FileForDisplay | null;
  loading: boolean;
  error: string | null;
  /** Wrap long lines instead of horizontal-scrolling them (global
   * toggle, off by default). Same content-visibility trade-off as
   * DiffView's wrap prop: rows lose row-level virtualization while this
   * is on, since a wrapped row's height is no longer a known constant. */
  wrap?: boolean;
}>();

const highlighted = computed(() => {
  if (props.path === null || props.file === null) return null;
  const { binary, tooLarge, content } = props.file;
  if (binary || tooLarge || content === '') return null;
  return highlightContent(content, props.path);
});

const lineNumWidth = computed(() => {
  const count = highlighted.value?.lines.length ?? 0;
  return `${Math.max(3, String(count).length)}ch`;
});

/** File is loaded, text, and genuinely empty (zero-byte or whitespace-free). */
const isEmptyFile = computed(
  () =>
    props.file !== null && !props.file.binary && !props.file.tooLarge && props.file.content === ''
);

/**
 * The browser refused to decode bytes the daemon accepted. Falls back to
 * the plain binary note (which is why that branch is widened to
 * `binary || media`) rather than to "too large" — one note, one testid.
 */
const imageFailed = ref(false);

watch(
  () => [props.path, props.file],
  () => {
    imageFailed.value = false;
  }
);

/** The ` · …` tail of the binary note; empty string renders no span at all. */
const refusalSuffix = computed(() => {
  if (imageFailed.value) return ' · preview failed to decode';
  const refusal = props.file?.media?.refusal ?? null;
  const text = refusal === null ? null : REFUSAL_TEXT[refusal];
  return text === null ? '' : ` · ${text}`;
});

/** The daemon's image verdict, when it produced one. */
const image = computed(() => props.file?.media?.image ?? null);

/** Animated GIFs only: the still ones carry no frame count. */
const frames = computed(() => {
  const count = image.value?.frames ?? 1;
  return count > 1 ? count : null;
});
</script>

<template>
  <div class="file-pane">
    <header v-if="path" class="pane-header mono" data-testid="file-header">
      <span class="file-path" :title="path">{{ path }}</span>
      <span class="file-meta">
        <!-- The format chip reuses .file-lang: both answer "what is this
             file", and they are mutually exclusive by construction — an
             image is never highlighted. -->
        <span v-if="highlighted?.language" class="file-lang">{{ highlighted.language }}</span>
        <span v-if="image" class="file-lang" data-testid="file-format">{{ image.format }}</span>
        <!-- U+00D7 MULTIPLICATION SIGN, not the letter x. -->
        <span v-if="image" class="mono" data-testid="file-dimensions"
          >{{ image.width }} × {{ image.height }}</span
        >
        <span v-if="frames" data-testid="file-frames">{{ frames }} frames</span>
        <span v-if="file" class="file-size">{{ formatBytes(file.size) }}</span>
        <WrapToggle />
      </span>
    </header>

    <div class="pane-body">
      <p v-if="path === null" class="pane-note" data-testid="file-prompt">Select a file</p>

      <p v-else-if="error" class="pane-note pane-error mono" data-testid="file-error">
        {{ error }}
      </p>

      <p v-else-if="file === null" class="pane-note" data-testid="file-loading">
        {{ loading ? 'Loading…' : '' }}
      </p>

      <ImageView
        v-else-if="file.media?.image && !imageFailed"
        :path="path"
        :media="file.media"
        @fail="imageFailed = true"
      />

      <p v-else-if="file.binary || file.media" class="pane-note" data-testid="file-binary">
        Binary file — {{ formatBytes(file.size)
        }}<span v-if="refusalSuffix" data-testid="image-refused">{{ refusalSuffix }}</span>
      </p>

      <p v-else-if="file.tooLarge" class="pane-note" data-testid="file-too-large">
        File too large to display ({{ formatBytes(file.size) }})
      </p>

      <p v-else-if="isEmptyFile" class="pane-note" data-testid="file-empty">Empty file</p>

      <div
        v-else-if="highlighted"
        class="code-scroll mono"
        :class="{ wrap }"
        data-testid="file-content"
      >
        <div
          class="code-lines"
          :class="{ stale: loading }"
          :style="{ '--ln-w': lineNumWidth }"
        >
          <div
            v-for="(line, i) in highlighted.lines"
            :key="i"
            class="code-row"
            :data-ln="i + 1"
          >
            <span class="ln code-gutter">{{ i + 1 }}</span>
            <!-- Safe by construction: every line is escaped and
                 span-balanced by utils/highlight (see its module docs). -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span class="code code-cell" v-html="line"></span>
          </div>
        </div>
        <p v-if="file.truncated" class="truncated-note mono" data-testid="file-truncated">
          Truncated — showing the first {{ highlighted.lines.length.toLocaleString() }} of
          {{ file.totalLines.toLocaleString() }} lines.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-pane {
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* A card, exactly like a file in the diff stack: this pane paints
     var(--bg) for its code area, so on the page's own --bg it had no visible
     edge at all — which is why Explorer had to draw a panel border-right
     instead. Re-pointing --bg fills the body with the card colour, and the
     border gives it the edge the stack's cards have. overflow:hidden was
     already here, so nothing about sticky rooting changes. */
  border: 1px solid var(--border);
  border-radius: 4px;
  --bg: var(--file-bg);
}

.pane-header {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-small);
}

.file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.file-meta {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  color: var(--text-dim);
}

.file-lang {
  padding: 0 0.375rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: var(--fs-micro);
}

.pane-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pane-note {
  margin: auto;
  padding: 1rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
  text-align: center;
}

.pane-error {
  color: var(--del);
  font-size: var(--fs-small);
}

/* --- Code viewer --- */

.code-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  font-size: var(--fs-base);
  line-height: 1.55;
}

.code-lines {
  width: max-content;
  min-width: 100%;
  padding: 0.25rem 0 0.5rem;
}

/* Wrap mode: max-content would size to the longest UNWRAPPED line,
   defeating wrapping — pin to the scroller's own width instead, same
   reasoning as DiffView's wrap-mode override. */
.code-scroll.wrap .code-lines,
.code-scroll.wrap .code-row {
  width: 100%;
}

/* A quietly dimmed body while a newer file load is in flight. */
.code-lines.stale {
  opacity: 0.55;
}

.code-row {
  display: grid;
  grid-template-columns: var(--ln-w, 3ch) 1fr;
  column-gap: 1.25ch;
  width: max-content;
  min-width: 100%;
  /* Virtualization: off-screen rows skip layout + paint (see DiffView).
     Same probed row height (--row-h, published by DiffStack's
     measureProbe on the document root) so skipped rows never drift
     from realized ones; the rem value is only the pre-probe fallback. */
  content-visibility: auto;
  contain-intrinsic-size: auto var(--row-h);
}

/* Wrap mode: a wrapped row's real height is no longer the constant the
   above intrinsic-size assumes, so virtualizing it would size a skipped
   row wrong and cause a jump on realize. Same trade-off as DiffView. */
.code-scroll.wrap .code-row {
  content-visibility: visible;
}

.ln {
  position: sticky;
  left: 0;
  padding-right: 0.5ch;
  background: var(--bg);
}

.code-scroll.wrap .code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.truncated-note {
  margin: 0;
  padding: 0.375rem 0.75rem;
  border-top: 1px solid var(--border);
  color: var(--warn);
  font-size: var(--fs-small);
  position: sticky;
  left: 0;
}

/* The highlight.js class → theme token mapping is global (theme/hljs.css,
   imported in main.ts): the Explorer file viewer and the diff's syntax
   mode share one copy instead of each carrying its own. */
</style>
