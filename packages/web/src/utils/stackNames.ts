/**
 * The part every layer name of a stack starts with, so the strip can say
 * it once instead of on every layer.
 *
 * Stack branches are usually named alike (`feature/aer-4673-jsp-to-html`,
 * `feature/aer-4693-nginx`, …): six of them side by side spend most of
 * their width repeating `feature/aer-`. The prefix is cut only at a
 * separator (`/`, `-`, `_`, `.`), never inside a word, so `aer-4673` and
 * `aer-4693` share `aer-` and not `aer-46`. Nothing is cut when a name
 * would be left empty, or when there is only one name to compare.
 */

const SEPARATORS = new Set(['/', '-', '_', '.']);

export function sharedPrefix(names: readonly string[]): string {
  if (names.length < 2) return '';
  let common = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < common.length && i < name.length && common[i] === name[i]) i++;
    common = common.slice(0, i);
  }
  // Back off to the last separator inside the common run, so the cut
  // lands between words.
  let end = common.length;
  while (end > 0 && !SEPARATORS.has(common[end - 1])) end--;
  const prefix = common.slice(0, end);
  return names.every((name) => name.length > prefix.length) ? prefix : '';
}
