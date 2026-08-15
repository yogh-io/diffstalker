<script setup lang="ts">
/**
 * Empty state: no repository is active. Mounts the SAME RepoPicker the
 * header switcher does — filter by name, or type an absolute path on the
 * daemon's machine to open something new — so the two ways in cannot say
 * different things about which repos exist.
 *
 * It had its own flat list of recents before, painted straight from
 * localStorage. That list is gone with the picker's arrival: it could not
 * fold worktrees into projects, so a project with three worktrees read as
 * three repos here and as one everywhere else.
 */

import RepoPicker from './RepoPicker.vue';
</script>

<template>
  <div class="empty-state" data-testid="empty-state">
    <div class="card">
      <span class="mark" aria-hidden="true">
        <span class="cell add"></span>
        <span class="cell del"></span>
        <span class="cell ctx"></span>
      </span>
      <h1>Open a repository</h1>
      <p class="copy">
        diffstalker follows a repository on the daemon's machine. Type a name to pick one it
        already knows, or an absolute path to open a new one.
      </p>
      <RepoPicker />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
}

.card {
  width: 30rem;
  max-width: 100%;
}

/* Three gutter cells: add, del, context — the app's subject in 24px. */
.mark {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 1rem;
}

.cell {
  height: 0.375rem;
  border-radius: 1px;
}

.cell.add {
  width: 1.75rem;
  background: var(--add);
}

.cell.del {
  width: 1.25rem;
  background: var(--del);
}

.cell.ctx {
  width: 2.25rem;
  background: var(--border);
}

h1 {
  margin: 0 0 0.5rem;
  font-size: var(--fs-display);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.copy {
  margin: 0 0 1.25rem;
  font-size: var(--fs-content);
  color: var(--text-dim);
}
</style>
