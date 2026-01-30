import { describe, it, expect } from 'vitest';
import { formatDate, formatDateAbsolute } from './formatDate.js';

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
