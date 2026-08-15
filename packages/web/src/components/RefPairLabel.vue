<script setup lang="ts">
/**
 * RefPairLabel: what this diff is BETWEEN, printed in the file header.
 *
 * Purely presentational — the vocabulary lives in utils/refPair so the
 * four surfaces that show it cannot drift apart on wording.
 *
 * It exists because the app always knew the answer and never said it. The
 * pair is not editable and never becomes an input: whole-file mode
 * inherits the pair from the view for the same reason.
 */

import { computed } from 'vue';
import { refPairLabel, refPairTitle, type RefPair } from '../utils/refPair';

const props = defineProps<{ pair: RefPair }>();

const label = computed(() => refPairLabel(props.pair));
const title = computed(() => refPairTitle(props.pair));
</script>

<template>
  <span class="ref-pair mono" data-testid="ref-pair" :title="title">{{ label }}</span>
</template>

<style scoped>
/* The same height contract every other header inhabitant signs: zero
   block padding, no border, one line, never wrapping. DiffStack measures
   ONE header and applies that number to every section in the stack, so
   anything here that could grow taller mis-tops the whole stack. */
.ref-pair {
  flex: none;
  padding: 0;
  color: var(--text-dim);
  font-size: var(--fs-micro);
  white-space: nowrap;
  /* It answers a question the reader only sometimes has, so it must not
     compete with the path it follows: it shrinks before anything else
     and disappears entirely rather than pushing the buttons off. */
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
</style>
