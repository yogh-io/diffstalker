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

function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * Format a timestamp as a long-form relative time:
 * "just now", "42 seconds ago", "5 minutes ago", "3 hours ago", "2 days ago",
 * "2 weeks ago", "3 months ago", "1 year ago".
 */
export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - timestampMs);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return ago(seconds, 'second');
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return ago(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return ago(days, 'day');
  if (days < 30) return ago(Math.floor(days / 7), 'week');
  if (days < 365) return ago(Math.floor(days / 30), 'month');
  return ago(Math.floor(days / 365), 'year');
}

/**
 * Format a date as an absolute date/time string.
 * Used for commit details where exact timestamp is needed.
 * Example: "Jan 15, 2024, 10:30 AM"
 */
export function formatDateAbsolute(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
