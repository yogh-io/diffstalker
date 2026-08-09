<script setup lang="ts">
/**
 * HotkeysOverlay: the keyboard-shortcut reference (`?`) — the web
 * analog of the CLI's HotkeysModal. Static content, interface voice.
 * Esc, `?`, the close button, or a click outside closes it (Esc and
 * `?` are handled by the global key layer). Focus is trapped and
 * returns on close.
 *
 * The groups are deliberately small and near-equal, none past five
 * rows. They were one 18-row "Global" block against six three-row
 * ones, and no column layout can balance that — the tall block sets
 * the height and the space beside it is dead. A group that outgrows
 * five rows is a content bug here, not a CSS one: `break-inside:
 * avoid` makes the tallest group a floor under every column.
 */

import { ref } from 'vue';
import { useUiStore, VIEWS } from '../stores/ui';
import { useFocusTrap } from '../composables/useFocusTrap';

const ui = useUiStore();

const dialogEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

interface HotkeyEntry {
  /** One chord per item. Several means alternatives, not a sequence. */
  keys: string[];
  description: string;
}

interface HotkeyGroup {
  title: string;
  /** A condition every row shares that the keys cannot show. */
  note?: string;
  entries: HotkeyEntry[];
}

const GROUPS: HotkeyGroup[] = [
  {
    title: 'Open',
    // Scoped to this group on purpose: these two chords take Ctrl or
    // Command, but the find boxes below test ctrlKey alone.
    note: 'On a Mac, use Command instead of Ctrl.',
    entries: [
      { keys: ['Ctrl P'], description: 'Find file by name' },
      { keys: ['Ctrl ⇧ F'], description: 'Search file contents' },
      // Shift+F, not a bare f: the handler tests for the capital.
      { keys: ['⇧ F'], description: 'Search, without the chord' },
      { keys: ['/'], description: 'Filter the file list' },
      { keys: ['o'], description: 'Outline, in Explorer' },
    ],
  },
  {
    title: 'Switch view',
    // Derived from the rail order, like useGlobalKeys — it is the only
    // thing keeping the digits and the tab band in step.
    entries: VIEWS.map((view, index) => ({
      keys: [String(index + 1)],
      description: view.label,
    })),
  },
  {
    title: 'Change the display',
    note: 'Wrap long lines is a button. It has no key.',
    entries: [
      { keys: ['a'], description: 'Jump to the newest change' },
      { keys: ['s'], description: 'Syntax highlighting' },
      { keys: ['d'], description: 'Split or unified diff' },
      { keys: ['f'], description: 'Follow mode' },
      { keys: ['e'], description: 'Expand every big diff' },
    ],
  },
  {
    title: 'Lists (files, commits)',
    entries: [
      { keys: ['↑ ↓'], description: 'Move selection' },
      // Enter and Space are not one key: Enter hands focus to the diff,
      // Space leaves it in the list so arrowing keeps working.
      { keys: ['Enter'], description: 'Select, focus the diff' },
      { keys: ['Space'], description: 'Select, stay in the list' },
      { keys: ['Tab'], description: 'Next focus stop' },
      { keys: ['Enter', 'Space'], description: 'Fold a commit, in Journal' },
    ],
  },
  {
    title: 'Trees (Explorer, Compare)',
    entries: [
      { keys: ['→'], description: 'Expand, or step in' },
      { keys: ['←'], description: 'Collapse, or go up' },
      { keys: ['Home', 'End'], description: 'First or last row' },
    ],
  },
  {
    title: 'Find, search, outline',
    note: 'Find file reveals the result in Explorer.',
    entries: [
      { keys: ['Type'], description: 'Narrow the list' },
      { keys: ['↑ ↓', 'Ctrl j k'], description: 'Move selection' },
      { keys: ['Enter'], description: 'Go to the result' },
      { keys: ['Tab', '⇧ Tab'], description: 'Cycle results, in Find file' },
      { keys: ['Esc'], description: 'Close' },
    ],
  },
  {
    title: 'Filter (/)',
    entries: [
      { keys: ['/'], description: 'Open, or focus the box' },
      { keys: ['Esc'], description: 'Clear and close' },
    ],
  },
  {
    title: 'Panes',
    note: 'j and k need the stacked layout.',
    entries: [
      { keys: ['j k'], description: 'Move, or scroll the diff' },
      { keys: ['↑ ↓ ← →'], description: 'Resize, on the divider' },
    ],
  },
  {
    title: 'Help and closing',
    entries: [
      { keys: [','], description: 'Settings' },
      { keys: ['?'], description: 'This help' },
      { keys: ['Esc'], description: 'Close what is open' },
    ],
  },
];
</script>

<template>
  <div class="overlay-scrim" data-testid="hotkeys-overlay" @click.self="ui.closeOverlay()">
    <div
      ref="dialogEl"
      class="overlay-dialog hotkeys"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabindex="-1"
    >
      <header class="hotkeys-header">
        <h2 class="hotkeys-title">Keyboard shortcuts</h2>
        <button
          class="hotkeys-close"
          data-autofocus
          data-testid="hotkeys-close"
          aria-label="Close"
          @click="ui.closeOverlay()"
        >
          ×
        </button>
      </header>

      <!--
        The scroller and the column box are two elements on purpose; see
        .hotkeys-columns. tabindex makes the region reachable without a
        pointer: arrow keys scroll the nearest scrollable ANCESTOR of the
        focused element, and the close button has none.
      -->
      <div
        class="hotkeys-body"
        data-testid="hotkeys-body"
        tabindex="0"
        role="region"
        aria-label="Shortcut list"
      >
        <div class="hotkeys-columns">
          <section v-for="group in GROUPS" :key="group.title" class="hotkeys-group">
            <h3 class="group-title eyebrow">{{ group.title }}</h3>
            <p v-if="group.note" class="group-note">{{ group.note }}</p>
            <dl class="group-entries">
              <template v-for="entry in group.entries" :key="entry.keys.join(' ')">
                <dt class="entry-keys">
                  <!-- The "or" travels inside its chip's wrapper so a wrap
                       never strands it at the end of the line above. -->
                  <span v-for="(key, index) in entry.keys" :key="key" class="key-alt">
                    <span v-if="index > 0" class="key-or">or</span>
                    <kbd class="mono">{{ key }}</kbd>
                  </span>
                </dt>
                <dd>{{ entry.description }}</dd>
              </template>
            </dl>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * This sheet is sized to hold COLUMNS of key/description pairs, not a
 * line of prose. That is the one way it differs from the other three
 * overlays, and it is why it does not share their width.
 */
.hotkeys {
  /* Four columns of (7rem key cap + 0.875rem + ~11rem description),
     three 2rem gaps, 2rem of body padding. Four is where the whole
     sheet clears the fold on a laptop; wider only lengthens the sweep
     across rows that are already all visible. Derived, not chosen — if
     the key cap or the column track below moves, this moves with it. */
  width: min(84rem, calc(100vw - 2rem));

  /* The scrim pushes every dialog down by clamp(2rem, 12vh, 8rem)
     before this budget applies. The flat `100vh - 4rem` it replaces
     never subtracted that, so on a short window the foot of the sheet
     sat below a scrim that has no overflow — clipped, with nothing able
     to scroll to it. dvh against the scrim's own vh can only
     under-fill, never clip. No rem floor: with the columns balanced the
     sheet is shorter than this on any desktop, and a dialog that hugs
     its content is the point. */
  max-height: calc(100dvh - clamp(2rem, 12vh, 8rem) - 2rem);

  display: flex;
  flex-direction: column;
}

/* Header, title and close button are byte-identical to SettingsOverlay's.
   Two overlays sharing one chrome is deliberate — a change here has to be
   made twice to stay true. */
.hotkeys-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.hotkeys-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}

.hotkeys-close {
  padding: 0 0.375rem;
  font-size: var(--fs-title);
  line-height: 1;
  color: var(--text-dim);
  border-radius: 4px;
}

.hotkeys-close:hover {
  color: var(--text);
}

/* The one scroller, at every width. It is its own element because the
   column box inside it must keep an auto height — see .hotkeys-columns. */
.hotkeys-body {
  overflow-y: auto;
  /* A flick that runs out of sheet must not start scrolling the diff
     behind the scrim. */
  overscroll-behavior: contain;
  padding: 1rem;
}

/* Ring drawn inside: a scroll container clips its own outline on the
   leading edge. */
.hotkeys-body:focus-visible {
  outline: 2px solid var(--selection);
  outline-offset: -2px;
}

/* Multi-column, not grid. A grid row is as tall as its tallest cell, so
   a three-row group placed beside an eighteen-row one was stretched to
   match it — that stretch was the empty rectangle, and widening the
   dialog only widened it. Columns have no rows: a short group packs
   against the bottom of whatever precedes it, and the engine balances
   the column heights for free. The count follows the available width,
   which is why this layout needs no breakpoint.

   This box MUST keep an auto height. A multicol container with a
   constrained height does not grow a scrollbar — it fragments SIDEWAYS,
   laying out extra columns past its right edge, which the app's
   `overflow-x: hidden` then swallows whole. Auto height is also the
   condition under which column-fill balances at all. So the cap and the
   overflow live on .hotkeys-body above, never here. */
.hotkeys-columns {
  column-width: 17rem;
  column-gap: 2rem;
  column-rule: 1px solid var(--border);
}

.hotkeys-group {
  /* A group is the atom of the flow: its title never lands at the foot
     of one column with its rows at the head of the next. It also makes
     the tallest group a floor under the balanced column height, which
     is why none of them runs past five rows. */
  break-inside: avoid;
  margin: 0 0 1.25rem;
}

.group-title {
  margin: 0 0 0.375rem;
  font-weight: 500;
}

/* A condition the whole block shares, said once above it. Per row it
   would repeat inside every description and set the column width. */
.group-note {
  margin: 0 0 0.5rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.group-entries {
  margin: 0;
  display: grid;
  /* fit-content caps the key cell. An `auto` track hands the widest row
     — two alternate chords — the width for all 35 rows, and every
     description then wraps against the leftovers; that was the "narrow
     description column beside dead space". Past the cap the alternates
     wrap under each other instead, a cost paid by the two rows that
     have them rather than by the column. 7rem clears the widest single
     chip (Home, Ctrl j k) with room, so the track's min-content
     contribution never breaches the cap. */
  grid-template-columns: fit-content(7rem) 1fr;
  gap: 0.25rem 0.875rem;
  align-items: baseline;
}

.entry-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem;
}

/* One alternative is one unbreakable unit, so a wrap moves the "or"
   down with the chip it belongs to instead of stranding it at the end
   of the line above. */
.key-alt {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
}

.key-or {
  color: var(--text-dim);
  font-size: var(--fs-small);
}

.group-entries dd {
  margin: 0;
  font-size: var(--fs-base);
  color: var(--text);
}

kbd {
  display: inline-block;
  padding: 0 0.375rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface-raised);
  font-size: var(--fs-small);
  color: var(--text-dim);
  white-space: nowrap;
}
</style>
