import { describe, expect, it } from 'vitest';
import { altFromFilename, mediaMarkdown, plural, slugify, spliceText, stampFilename, truncate } from './text';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('My Deck Name')).toBe('my-deck-name');
  });

  it('strips punctuation accents keep the base letter', () => {
    expect(slugify('Café México!')).toBe('cafe-mexico');
  });

  it('falls back when nothing survives', () => {
    expect(slugify('!!!', 'fallback')).toBe('fallback');
  });

  it('caps length', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe('stampFilename', () => {
  it('formats as YYYY-MM-DD-HHmm', () => {
    const at = new Date(2024, 2, 7, 9, 5).getTime(); // March 7 2024, 09:05 local
    expect(stampFilename(at)).toBe('2024-03-07-0905');
  });
});

describe('truncate', () => {
  it('collapses whitespace and trims', () => {
    expect(truncate('  a   b\n  c  ', 50)).toBe('a b c');
  });

  it('cuts long text with an ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });

  it('leaves short text untouched', () => {
    expect(truncate('short', 50)).toBe('short');
  });
});

describe('plural', () => {
  it('singular for 1', () => {
    expect(plural(1, 'note')).toBe('1 note');
  });

  it('plural otherwise, including 0', () => {
    expect(plural(0, 'note')).toBe('0 notes');
    expect(plural(2, 'note')).toBe('2 notes');
  });
});

describe('spliceText', () => {
  it('inserts at a collapsed cursor', () => {
    const result = spliceText('hello world', 5, 5, ',');
    expect(result.text).toBe('hello, world');
    expect(result.caret).toBe(6);
  });

  it('replaces a selection', () => {
    const result = spliceText('hello world', 6, 11, 'there');
    expect(result.text).toBe('hello there');
    expect(result.caret).toBe(11);
  });

  it('inserts at the start and end', () => {
    expect(spliceText('abc', 0, 0, 'X').text).toBe('Xabc');
    expect(spliceText('abc', 3, 3, 'X').text).toBe('abcX');
  });
});

describe('mediaMarkdown', () => {
  it('builds a media reference', () => {
    expect(mediaMarkdown('abc-123', 'a diagram')).toBe('![a diagram](media:abc-123)');
  });

  it('allows an empty alt', () => {
    expect(mediaMarkdown('abc-123', '')).toBe('![](media:abc-123)');
  });

  it('strips brackets from alt so the reference stays parseable', () => {
    // An unescaped `]` would close the alt text early and leave the rest of
    // it, plus the real `(media:…)` part, as stray text on the card.
    expect(mediaMarkdown('abc-123', 'before]after')).toBe('![beforeafter](media:abc-123)');
    expect(mediaMarkdown('abc-123', '[weird] name')).toBe('![weird name](media:abc-123)');
  });
});

describe('altFromFilename', () => {
  it('drops the extension', () => {
    expect(altFromFilename('diagram.png')).toBe('diagram');
  });

  it('turns separators into spaces', () => {
    expect(altFromFilename('kerberos_attack-flow.jpg')).toBe('kerberos attack flow');
  });

  it('handles a name with no extension', () => {
    expect(altFromFilename('screenshot')).toBe('screenshot');
  });

  it('trims leftover whitespace', () => {
    expect(altFromFilename('  spaced out .png')).toBe('spaced out');
  });
});
