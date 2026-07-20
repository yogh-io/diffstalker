import { describe, it, expect } from 'vitest';
import { formatDate, formatDateAbsolute, formatRelativeTime } from './formatDate.js';

describe('formatDate', () => {
  it('formats minutes ago for recent dates', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatDate(date)).toBe('5m ago');
  });

  it('formats hours ago for dates within 48h', () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatDate(date)).toBe('3h ago');
  });

  it('formats hours up to 47h', () => {
    const date = new Date(Date.now() - 47 * 60 * 60 * 1000);
    expect(formatDate(date)).toBe('47h ago');
  });

  it('formats days for dates within 14 days', () => {
    const date = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    expect(formatDate(date)).toBe('5d ago');
  });

  it('formats as date beyond 14 days', () => {
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = formatDate(date);
    // Should be formatted like "Jan 15" (month short + day)
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('formats 0 minutes for very recent dates', () => {
    const date = new Date(Date.now() - 10 * 1000);
    expect(formatDate(date)).toBe('0m ago');
  });
});

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000;
  const at = (msAgo: number) => formatRelativeTime(NOW - msAgo, NOW);

  it('says just now under 10 seconds', () => {
    expect(at(0)).toBe('just now');
    expect(at(9_000)).toBe('just now');
  });

  it('shows seconds under a minute', () => {
    expect(at(10_000)).toBe('10 seconds ago');
    expect(at(42_000)).toBe('42 seconds ago');
  });

  it('shows minutes under an hour', () => {
    expect(at(60_000)).toBe('1 minute ago');
    expect(at(5 * 60_000)).toBe('5 minutes ago');
    expect(at(59 * 60_000)).toBe('59 minutes ago');
  });

  it('shows hours under a day', () => {
    expect(at(60 * 60_000)).toBe('1 hour ago');
    expect(at(23 * 60 * 60_000)).toBe('23 hours ago');
  });

  it('shows days under a week', () => {
    expect(at(24 * 60 * 60_000)).toBe('1 day ago');
    expect(at(2 * 24 * 60 * 60_000)).toBe('2 days ago');
  });

  it('shows weeks under a month', () => {
    expect(at(14 * 24 * 60 * 60_000)).toBe('2 weeks ago');
  });

  it('shows months under a year', () => {
    expect(at(60 * 24 * 60 * 60_000)).toBe('2 months ago');
  });

  it('shows years beyond that', () => {
    expect(at(400 * 24 * 60 * 60_000)).toBe('1 year ago');
  });

  it('treats future timestamps as just now', () => {
    expect(at(-5_000)).toBe('just now');
  });
});

describe('formatDateAbsolute', () => {
  it('formats with year, month, day, and time', () => {
    const date = new Date(2024, 0, 15, 10, 30);
    const result = formatDateAbsolute(date);
    expect(result).toContain('Jan');
    expect(result).toContain('15');
    expect(result).toContain('2024');
    expect(result).toContain('10:30');
  });

  it('includes AM/PM', () => {
    const date = new Date(2024, 5, 20, 14, 45);
    const result = formatDateAbsolute(date);
    expect(result).toMatch(/AM|PM/);
  });
});
