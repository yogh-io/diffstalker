import { describe, it, expect } from 'vitest';
import {
  bodyDiffersFromDraft,
  composeBody,
  countPlaceholders,
  draftChangeTouches,
  normalizeBody,
  placeholderPattern,
  placeholderRanges,
  topZoneOf,
  replaceTopZone,
} from './prBody.js';

const AI = '<details>\n<summary>AI notes</summary>\n\nbody\n</details>';

describe('placeholders', () => {
  it('finds each {{...}} with its range', () => {
    const text = 'Uses nginx. {{why nginx and not caddy?}} Then {{link}}.';
    const ranges = placeholderRanges(text);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual([
      '{{why nginx and not caddy?}}',
      '{{link}}',
    ]);
    expect(countPlaceholders(text)).toBe(2);
  });

  it('needs something inside', () => {
    expect(countPlaceholders('{{}}')).toBe(0);
  });

  it('does not span lines', () => {
    expect(countPlaceholders('{{one\ntwo}}')).toBe(0);
  });

  it('does not nest', () => {
    const text = '{{a {{b}} c}}';
    const ranges = placeholderRanges(text);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['{{b}}']);
  });

  it('counts none in plain text and in single braces', () => {
    expect(countPlaceholders('')).toBe(0);
    expect(countPlaceholders('a {b} c')).toBe(0);
  });

  it('hands out a fresh matcher every time', () => {
    const first = placeholderPattern();
    first.exec('{{a}}');
    expect(first.lastIndex).toBeGreaterThan(0);
    expect(placeholderPattern().lastIndex).toBe(0);
  });
});

describe('normalizeBody', () => {
  it('turns CRLF into LF and trims', () => {
    expect(normalizeBody('\r\n  a\r\nb  \r\n')).toBe('a\nb');
  });
});

describe('composeBody', () => {
  it('joins the zones with a blank line and ---', () => {
    expect(composeBody('  Why.\n', `\n${AI}\n`)).toBe(`Why.\n\n---\n${AI}`);
  });

  it('is the top alone without an AI zone', () => {
    expect(composeBody('Why.\n', null)).toBe('Why.');
    expect(composeBody('Why.\n', '  \n')).toBe('Why.');
  });

  it('has no leading blank lines without a top', () => {
    expect(composeBody(null, AI)).toBe(`---\n${AI}`);
    expect(composeBody('', '')).toBe('');
  });

  it('normalizes line endings in both zones', () => {
    expect(composeBody('a\r\nb', 'c\r\nd')).toBe('a\nb\n\n---\nc\nd');
  });
});

describe('topZoneOf', () => {
  it('reads back the top a composed body was made from', () => {
    expect(topZoneOf(composeBody('Why.\n\nAnd how.', AI))).toBe('Why.\n\nAnd how.');
    expect(topZoneOf(composeBody(null, AI))).toBe('');
  });

  it('cuts at --- followed by <details> after blank lines', () => {
    expect(topZoneOf(`Top.\n\n---\n\n\n${AI}`)).toBe('Top.');
  });

  it('handles CRLF bodies, as GitHub sends them', () => {
    expect(topZoneOf(`Top.\r\n\r\n---\r\n${AI.replace(/\n/g, '\r\n')}`)).toBe('Top.');
  });

  it('skips a --- that is not followed by <details>', () => {
    const body = `One.\n\n---\n\nTwo.\n\n---\n${AI}`;
    expect(topZoneOf(body)).toBe('One.\n\n---\n\nTwo.');
  });

  it('is the whole body when no cut line exists', () => {
    expect(topZoneOf('  Just text.\n\n---\n\nMore.\n')).toBe('Just text.\n\n---\n\nMore.');
    expect(topZoneOf('')).toBe('');
  });

  it('wants the line to be exactly ---', () => {
    expect(topZoneOf(`Top.\n----\n${AI}`)).toBe(`Top.\n----\n${AI}`);
    expect(topZoneOf(`Top.\n--- \n${AI}`)).toBe(`Top.\n--- \n${AI}`);
  });

  it('wants <details> at the start of its line', () => {
    expect(topZoneOf('Top.\n---\n  <details>')).toBe('Top.\n---\n  <details>');
    expect(topZoneOf('Top.\n---\ntext <details>')).toBe('Top.\n---\ntext <details>');
  });

  it('does not cut at a --- that ends the body', () => {
    expect(topZoneOf('Top.\n---\n')).toBe('Top.\n---');
  });
});

describe('bodyDiffersFromDraft', () => {
  it('is false for the body the draft composes to', () => {
    expect(bodyDiffersFromDraft(composeBody('Why.', AI), 'Why.\n')).toBe(false);
  });

  it('ignores line endings and outer whitespace', () => {
    expect(bodyDiffersFromDraft(`a\r\nb\r\n\r\n---\r\n${AI}`, '\na\nb\n\n')).toBe(false);
  });

  it('is true when the top zone was edited on either side', () => {
    expect(bodyDiffersFromDraft(composeBody('Why.', AI), 'Why, really.')).toBe(true);
    expect(bodyDiffersFromDraft('Old text.', 'New text.')).toBe(true);
  });

  it('ignores the AI zone', () => {
    expect(bodyDiffersFromDraft(composeBody('Why.', '<details>other</details>'), 'Why.')).toBe(
      false
    );
  });
});

describe('draftChangeTouches', () => {
  it('matches the named branch', () => {
    expect(draftChangeTouches({ branch: 'feature/x', prefix: false }, 'feature/x')).toBe(true);
    expect(draftChangeTouches({ branch: 'feature/x', prefix: false }, 'feature/x/y')).toBe(false);
    expect(draftChangeTouches({ branch: 'feature', prefix: false }, 'feature/x')).toBe(false);
  });

  it('matches everything below a changed directory', () => {
    expect(draftChangeTouches({ branch: 'feature', prefix: true }, 'feature/x')).toBe(true);
    expect(draftChangeTouches({ branch: 'feature', prefix: true }, 'feature')).toBe(true);
    expect(draftChangeTouches({ branch: 'feature', prefix: true }, 'feature-2')).toBe(false);
  });

  it('matches every branch for the drafts root', () => {
    expect(draftChangeTouches({ branch: '', prefix: true }, 'anything/at/all')).toBe(true);
  });
});

describe('replaceTopZone', () => {
  const lower =
    '---\n<details>\n<summary>LLM-generated technical summary</summary>\n\nText.\n</details>';

  it('swaps the top zone and keeps the lower zone byte for byte', () => {
    expect(replaceTopZone(`Old words.\n\n${lower}`, '  New words.\n')).toBe(
      `New words.\n\n${lower}`
    );
  });

  it('a body with no lower zone becomes the new top', () => {
    expect(replaceTopZone('Old words.\n\n---\nnot details', 'New.')).toBe('New.');
  });

  it('an empty top leaves the lower zone alone', () => {
    expect(replaceTopZone(`Old.\r\n\r\n${lower.replace(/\n/g, '\r\n')}`, '')).toBe(lower);
  });

  it('the new top zone reads back as the top', () => {
    const body = replaceTopZone(`Old.\n\n${lower}`, 'New words.');
    expect(topZoneOf(body)).toBe('New words.');
  });
});
