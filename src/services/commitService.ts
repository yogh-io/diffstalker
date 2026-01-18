/**
 * Commit validation and logic service.
 * Contains pure functions for commit-related operations.
 */

export interface CommitValidationResult {
  valid: boolean;
  error: string | null;
}

/**
 * Validate commit message and staged state.
 */
export function validateCommit(
  message: string,
  stagedCount: number,
  amend: boolean
): CommitValidationResult {
  if (!message.trim()) {
    return { valid: false, error: 'Commit message cannot be empty' };
  }

  if (stagedCount === 0 && !amend) {
    return { valid: false, error: 'No changes staged for commit' };
  }

  return { valid: true, error: null };
}

/**
 * Format a commit message (trim whitespace, etc).
 */
export function formatCommitMessage(message: string): string {
  return message.trim();
}
