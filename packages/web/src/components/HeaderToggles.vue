<script setup lang="ts">
/**
 * The four global display toggles — auto mode, diff syntax highlighting,
 * unified/split diff, follow mode — as thin dot+letter keycaps (● a, ● s,
 * ● d, ● f — a/s/d/f are their home-row hotkeys; see useGlobalKeys). Lives
 * in the tab band (rendered by ActivityRail), NOT the header, so it costs
 * no header row. The dot (kept as the signature marker) and the whole pill
 * light up when on; the state detail (on/off, split vs unified, WHICH repo
 * is followed) lives in the hover tooltip + aria-label rather than
 * widening the button.
 *
 * Auto: flips the client-side auto-mode policy (useAutoMode acts on state
 * changes only while it is on). Follow: flips the client-side followEnabled
 * policy (useFollowMode acts on follow-change only while it is on — same
 * split as the CLI's FollowMode). The followed repo is named by
 * followedRepoId in the open-repo list — the same id the diffs switch to.
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import { basename } from '../utils/format';

const daemon = useDaemonStore();
const ui = useUiStore();

/** Daemon-side: is there a hook file to follow at all? */
const hasFollowTarget = computed(() => (daemon.follow?.targetFile ?? null) !== null);

/**
 * The followed repo, keyed by followedRepoId in the open-repo list — the
 * SAME id useFollowMode switches the active repo (and thus the diffs) to,
 * so the tooltip names whatever the diffs actually show. (A follow-change
 * event's `path` is the hook file content, often a file inside the repo,
 * so it must not be basenamed for the name.)
 */
const followedRepo = computed(() => {
  const id = daemon.follow?.followedRepoId ?? null;
  return id !== null ? (daemon.repos.find((r) => r.id === id) ?? null) : null;
});

const followedPath = computed(
  () => followedRepo.value?.path ?? daemon.follow?.followedPath ?? null
);

const followedName = computed(() => {
  if (followedRepo.value) return basename(followedRepo.value.path);
  const path = daemon.follow?.followedPath ?? null;
  return path ? basename(path) : null;
});

const followActive = computed(() => hasFollowTarget.value && daemon.followEnabled);

/** Concise follow state for the aria-label (no visible text carries it). */
const followState = computed(() => {
  if (!hasFollowTarget.value) return 'no target';
  if (!daemon.followEnabled) return 'off';
  return followedName.value ? `following ${followedName.value}` : 'on';
});

const followTitle = computed(() => {
  if (!hasFollowTarget.value) {
    return 'Follow (f): the daemon is not watching a follow hook file (started with --no-follow)';
  }
  const target = followedPath.value !== null ? `Following ${followedPath.value}. ` : '';
  return daemon.followEnabled
    ? `Follow (f) is on. ${target}Click to stop switching repos on follow changes`
    : `Follow (f) is off. Click to switch repos when the follow hook changes`;
});

const autoTitle = computed(() =>
  ui.autoModeEnabled
    ? 'Auto mode (a) is on: the newest change is selected and flashed, and the view follows changes appearing or drying up. Click to turn off'
    : 'Auto mode (a) is off. Click to auto-select the newest-changed file and auto-switch Changes/History'
);

const syntaxTitle = computed(() =>
  ui.diffSyntaxEnabled
    ? 'Diff syntax highlighting (s) is on for every diff. Click to show plain text'
    : 'Diff syntax highlighting (s) is off. Click to turn it on for every diff'
);

const splitOn = computed(() => ui.diffMode === 'split');
const modeTitle = computed(() =>
  splitOn.value
    ? 'Diff layout (d): side by side (old | new). Click for the unified view'
    : 'Diff layout (d): unified. Click for side by side (old | new)'
);
</script>

<template>
  <div class="header-toggles">
    <button
      class="key-toggle mono"
      data-testid="auto-toggle"
      :class="{ on: ui.autoModeEnabled }"
      :aria-pressed="ui.autoModeEnabled"
      :aria-label="`Auto mode (a): ${ui.autoModeEnabled ? 'on' : 'off'}`"
      :title="autoTitle"
      @click="ui.toggleAutoMode()"
    >
      <span class="dot" aria-hidden="true"></span><span class="key">a</span>uto
    </button>

    <button
      class="key-toggle mono"
      data-testid="syntax-toggle"
      :class="{ on: ui.diffSyntaxEnabled }"
      :aria-pressed="ui.diffSyntaxEnabled"
      :aria-label="`Diff syntax highlighting (s): ${ui.diffSyntaxEnabled ? 'on' : 'off'}`"
      :title="syntaxTitle"
      @click="ui.toggleDiffSyntax()"
    >
      <span class="dot" aria-hidden="true"></span><span class="key">s</span>yntax
    </button>

    <button
      class="key-toggle mono"
      data-testid="split-toggle"
      :class="{ on: splitOn }"
      :aria-pressed="splitOn"
      :aria-label="`Diff layout (d): ${splitOn ? 'split' : 'unified'}`"
      :title="modeTitle"
      @click="ui.toggleDiffMode()"
    >
      <span class="dot" aria-hidden="true"></span><span class="key">d</span>iff
    </button>

    <button
      v-if="daemon.follow"
      class="key-toggle mono"
      data-testid="follow-toggle"
      :class="{ on: followActive }"
      :disabled="!hasFollowTarget"
      :aria-pressed="followActive"
      :aria-label="`Follow mode (f): ${followState}`"
      :title="followTitle"
      @click="daemon.toggleFollow()"
    >
      <span class="dot" aria-hidden="true"></span><span class="key">f</span>ollow
    </button>
  </div>
</template>

<style scoped>
.header-toggles {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
  min-width: 0;
}

/* A compact pill: the signature dot + the word, with the hotkey letter
   picked out (bold, uppercase, accent) so the key is obvious. Lit when on.
   The on/off / mode / followed-repo detail is in the title + aria-label,
   not in visible text, so the button stays narrow. */
.key-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  height: 1.5rem;
  padding: 0 0.45rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: var(--fs-small);
  font-weight: 500;
  line-height: 1;
  color: var(--text-dim);
}

/* The hotkey letter: the "special style" — bold, uppercase, accent-tinted
   so it reads as the shortcut inside the word (aUto -> A, etc.). */
.key-toggle .key {
  font-weight: 800;
  text-transform: uppercase;
  color: var(--accent);
}

.key-toggle.on .key {
  color: inherit;
}

.key-toggle .dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--text-dim);
  flex: none;
}

.key-toggle:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--text-dim);
}

.key-toggle:disabled {
  opacity: 0.5;
}

/* On: the dot and the whole pill light up in the theme's add-green,
   adapting per theme via color-mix. */
.key-toggle.on {
  color: var(--text);
  border-color: color-mix(in srgb, var(--add) 60%, var(--border));
  background: color-mix(in srgb, var(--add) 18%, var(--surface));
}

.key-toggle.on:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--add) 80%, var(--border));
  background: color-mix(in srgb, var(--add) 26%, var(--surface));
}

.key-toggle.on .dot {
  background: var(--add);
  box-shadow: 0 0 6px color-mix(in srgb, var(--add) 70%, transparent);
}
</style>
