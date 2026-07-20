<script setup lang="ts">
/**
 * Placeholder shell: proves the SPA is served and can reach the daemon's
 * API same-origin. The real layout (header / rail / views) lands in the
 * next slices.
 */

import { ref, onMounted } from 'vue';

interface HealthWire {
  ok: boolean;
  ready: boolean;
}

const health = ref<HealthWire | null>(null);
const healthError = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`GET /health -> ${res.status}`);
    health.value = (await res.json()) as HealthWire;
  } catch (err) {
    healthError.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <main class="shell">
    <h1>diffstalker</h1>
    <p class="tagline">web UI scaffold — views land in the next slices</p>
    <p v-if="health" class="health">daemon health: ok={{ health.ok }} ready={{ health.ready }}</p>
    <p v-else-if="healthError" class="health error">daemon unreachable: {{ healthError }}</p>
    <p v-else class="health">checking daemon health…</p>
  </main>
</template>

<style scoped>
.shell {
  font-family: system-ui, sans-serif;
  max-width: 40rem;
  margin: 4rem auto;
  padding: 0 1rem;
}
.tagline {
  color: #888;
}
.health {
  font-family: monospace;
}
.health.error {
  color: #c66;
}
</style>
