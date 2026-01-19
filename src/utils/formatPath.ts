/**
 * Shorten a file path to fit within maxLength by putting ellipsis in the middle.
 * Keeps the first directory and filename visible as they're most informative.
 *
 * Example: "src/components/very/long/path/to/Component.tsx" (maxLength: 40)
 *       -> "src/components/…/Component.tsx"
 */
export function shortenPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }

  // Minimum length we'll go (don't truncate too aggressively)
  const minLength = 20;
  const effectiveMax = Math.max(maxLength, minLength);

  if (path.length <= effectiveMax) {
    return path;
  }

  const parts = path.split('/');

  // If it's just a filename with no directories, truncate the middle of the filename
  if (parts.length === 1) {
    const half = Math.floor((effectiveMax - 1) / 2);
    return path.slice(0, half) + '…' + path.slice(-(effectiveMax - half - 1));
  }

  const filename = parts[parts.length - 1];
  const firstPart = parts[0];

  // Reserve space for: firstPart + "/…/" + filename
  const ellipsis = '/…/';
  const minRequired = firstPart.length + ellipsis.length + filename.length;

  // If even the minimum doesn't fit, just show ellipsis + filename
  if (minRequired > effectiveMax) {
    const availableForFilename = effectiveMax - 2; // "…/"
    if (filename.length > availableForFilename) {
      // Truncate filename itself
      const half = Math.floor((availableForFilename - 1) / 2);
      return '…/' + filename.slice(0, half) + '…' + filename.slice(-(availableForFilename - half - 1));
    }
    return '…/' + filename;
  }

  // Try to include more path parts from the start
  let prefix = firstPart;
  let i = 1;

  while (i < parts.length - 1) {
    const nextPart = parts[i];
    const candidate = prefix + '/' + nextPart;

    if (candidate.length + ellipsis.length + filename.length <= effectiveMax) {
      prefix = candidate;
      i++;
    } else {
      break;
    }
  }

  // If we included all parts, return original (shouldn't happen given length check)
  if (i === parts.length - 1) {
    return path;
  }

  return prefix + ellipsis + filename;
}
