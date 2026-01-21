/**
 * Format a date relative to now:
 * - Hours for first 48 hours (e.g., "3h ago", "47h ago")
 * - Days for first 14 days (e.g., "3d ago")
 * - Date after that (e.g., "Jan 15")
 */
export function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (hours < 1) {
    const mins = Math.floor(diff / (1000 * 60));
    return `${mins}m ago`;
  } else if (hours < 48) {
    return `${hours}h ago`;
  } else if (days <= 14) {
    return `${days}d ago`;
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}
