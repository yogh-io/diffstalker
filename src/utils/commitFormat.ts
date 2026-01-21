/**
 * Format a commit message and refs for display within a given width.
 * Prioritizes message (min 20 chars), truncates refs first, then message.
 */
export interface CommitDisplayParts {
  displayMessage: string;
  displayRefs: string;
}

/**
 * Truncate a string with ellipsis if it exceeds maxLength.
 */
export function truncateWithEllipsis(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  if (maxLength <= 3) return str.slice(0, maxLength);
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format commit message and refs for display within available width.
 * Prioritizes message over refs, truncating refs first if needed.
 *
 * @param message - The commit message
 * @param refs - The commit refs (branch names, tags)
 * @param availableWidth - Total width available for message + refs
 * @param minMessageWidth - Minimum width to reserve for message (default: 20)
 */
export function formatCommitDisplay(
  message: string,
  refs: string | undefined,
  availableWidth: number,
  minMessageWidth: number = 20
): CommitDisplayParts {
  const refsStr = refs || '';

  // Calculate max space for refs (leave at least minMessageWidth for message + 1 for space)
  const maxRefsWidth = Math.max(0, availableWidth - minMessageWidth - 1);

  // Truncate refs if needed
  let displayRefs = refsStr;
  if (displayRefs.length > maxRefsWidth && maxRefsWidth > 3) {
    displayRefs = displayRefs.slice(0, maxRefsWidth - 3) + '...';
  } else if (displayRefs.length > maxRefsWidth) {
    displayRefs = ''; // Not enough space for refs
  }

  // Calculate message width (remaining space after refs)
  const refsWidth = displayRefs ? displayRefs.length + 1 : 0; // +1 for space before refs
  const messageWidth = Math.max(minMessageWidth, availableWidth - refsWidth);

  // Truncate message if needed
  const displayMessage = truncateWithEllipsis(message, messageWidth);

  return { displayMessage, displayRefs };
}
