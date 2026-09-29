/** Resolve after `ms` on the timer queue — the retry loops' one pause. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
