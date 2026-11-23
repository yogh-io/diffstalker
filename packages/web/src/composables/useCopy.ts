/**
 * useCopy: put text on the clipboard and say so for a moment. `state` is
 * `copied` or `failed` for COPY_NOTE_MS after a try, then null again.
 */

import { onUnmounted, shallowRef } from 'vue';
import { logFailure } from '../stores/failureLog';

export const COPY_NOTE_MS = 1500;

export function useCopy() {
  const state = shallowRef<'copied' | 'failed' | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function note(next: 'copied' | 'failed'): void {
    state.value = next;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => (state.value = null), COPY_NOTE_MS);
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      note('copied');
    } catch (err) {
      logFailure('copy to the clipboard', err);
      note('failed');
    }
  }

  onUnmounted(() => {
    if (timer !== null) clearTimeout(timer);
  });

  return { state, copy };
}
