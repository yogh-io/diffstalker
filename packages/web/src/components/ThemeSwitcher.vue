<script setup lang="ts">
/** Theme picker: the 6 CLI themes by display name. */

import { useId } from 'vue';
import { useUiStore } from '../stores/ui';
import { themeOrder, themes, isThemeName } from '../theme/themes';

const ui = useUiStore();
const selectId = useId();

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isThemeName(value)) ui.setTheme(value);
}
</script>

<template>
  <div class="theme-switcher">
    <label class="visually-hidden" :for="selectId">Theme</label>
    <select :id="selectId" :value="ui.theme" @change="onChange">
      <option v-for="name in themeOrder" :key="name" :value="name">
        {{ themes[name].displayName }}
      </option>
    </select>
  </div>
</template>

<style scoped>
select {
  font: inherit;
  font-size: var(--fs-small);
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.375rem;
}

select:hover {
  border-color: var(--text-dim);
}
</style>
