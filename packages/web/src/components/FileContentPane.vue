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
 */

import { computed } from 'vue';
import type { FileForDisplay } from '@diffstalker/core/git/explorerData';
import { highlightContent } from '../utils/highlight';
import { formatBytes } from '../utils/format';

const props = defineProps<{
  /** Repo-relative path of the selected file; null = nothing selected. */
  path: string | null;
  file: FileForDisplay | null;
  loading: boolean;
  error: string | null;
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
</script>

<template>
  <div class="file-pane">
    <header v-if="path" class="pane-header mono" data-testid="file-header">
      <span class="file-path" :title="path">{{ path }}</span>
      <span class="file-meta">
        <span v-if="highlighted?.language" class="file-lang">{{ highlighted.language }}</span>
        <span v-if="file" class="file-size">{{ formatBytes(file.size) }}</span>
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

      <p v-else-if="file.binary" class="pane-note" data-testid="file-binary">
        Binary file — {{ formatBytes(file.size) }}
      </p>

      <p v-else-if="file.tooLarge" class="pane-note" data-testid="file-too-large">
        File too large to display ({{ formatBytes(file.size) }})
      </p>

      <p v-else-if="isEmptyFile" class="pane-note" data-testid="file-empty">Empty file</p>

      <div v-else-if="highlighted" class="code-scroll mono" data-testid="file-content">
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
            <span class="ln">{{ i + 1 }}</span>
            <!-- Safe by construction: every line is escaped and
                 span-balanced by utils/highlight (see its module docs). -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span class="code" v-html="line"></span>
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
  contain-intrinsic-size: auto var(--row-h, 1.26rem);
}

.ln {
  position: sticky;
  left: 0;
  text-align: right;
  padding-left: 0.75ch;
  padding-right: 0.5ch;
  background: var(--bg);
  color: var(--diff-context-line-num);
  user-select: none;
}

.code {
  white-space: pre;
  tab-size: 4;
  padding-right: 1.5ch;
  color: var(--diff-text);
  /* Real content: opt back in against the body-wide non-selectable
     default so the file text is copyable. The .ln gutter stays
     user-select:none, so a selection copies clean code without line
     numbers. */
  user-select: text;
  -webkit-user-select: text;
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
