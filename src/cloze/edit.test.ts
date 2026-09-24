import { describe, expect, it } from 'vitest';
import { escapeClozeBody, renumberOrdinals, sameOrdinal, wrapAsCloze } from './edit';
import { clozeOrdinals, parseCloze } from './parse';
import type { ClozeNode } from './types';

const answerOf = (src: string, index = 0): string => {
  const node = parseCloze(src).nodes.filter((n): n is ClozeNode => n.kind === 'cloze')[index];
  return node.answer;
};

/** Wrap a whole string and read back what the answer parses to. */
const roundTrip = (selection: string): string => {
  const { text } = wrapAsCloze(selection, 0, selection.length, 1);
  return answerOf(text);
};

describe('escapeClozeBody', () => {
  it('escapes :: so a qualified name stays one answer', () => {
    expect(escapeClozeBody('std::vector')).toBe('std\\:\\:vector');
  });

  it('leaves a single colon alone', () => {
    expect(escapeClozeBody('Note: this')).toBe('Note: this');
  });

  it('leaves balanced braces readable', () => {
    expect(escapeClozeBody('\\frac{1}{2}')).toBe('\\frac{1}{2}');
  });

  it('escapes braces only when they cannot balance', () => {
    expect(escapeClozeBody('a}b')).toBe('a\\}b');
    expect(escapeClozeBody('a{b')).toBe('a\\{b');
  });

  it('doubles a backslash that would otherwise escape the next character', () => {
    expect(escapeClozeBody('a\\:b')).toBe('a\\\\:b');
  });

  it('leaves a backslash before an ordinary character alone', () => {
    expect(escapeClozeBody('\\frac')).toBe('\\frac');
  });
});

describe('wrapAsCloze round-trips', () => {
  it('survives text that is already tricky', () => {
    const cases = [
      'Paris',
      'std::vector',
      '[Net.WebClient]::DownloadString',
      '::1',
      '\\frac{1}{2}',
      'C:\\Windows\\System32',
      'a}b',
      'a{b',
      'a\\:b',
      'Note: this',
      '',
    ];
    for (const s of cases) {
      expect(roundTrip(s), `round-trip of ${JSON.stringify(s)}`).toBe(s);
    }
  });

  it('produces exactly one card', () => {
    const { text } = wrapAsCloze('std::vector', 0, 11, 1);
    expect(clozeOrdinals(text)).toEqual([1]);
  });

  it('produces no diagnostics for tricky selections', () => {
    for (const s of ['std::vector', '\\frac{1}{2}', 'a}b']) {
      const { text } = wrapAsCloze(s, 0, s.length, 1);
      expect(parseCloze(text).diagnostics, `diagnostics for ${s}`).toEqual([]);
    }
  });
});

describe('wrapAsCloze mechanics', () => {
  it('wraps only the selection', () => {
    const { text } = wrapAsCloze('The capital is Paris.', 15, 20, 1);
    expect(text).toBe('The capital is {{c1::Paris}}.');
  });

  it('selects the answer afterwards so it can be typed over', () => {
    const r = wrapAsCloze('The capital is Paris.', 15, 20, 1);
    expect(r.text.slice(r.selectionStart, r.selectionEnd)).toBe('Paris');
  });

  it('inserts an empty deletion and places the caret inside it', () => {
    const r = wrapAsCloze('abc', 3, 3, 1);
    expect(r.text).toBe('abc{{c1::}}');
    expect(r.selectionStart).toBe(9);
    expect(r.selectionEnd).toBe(9);
  });

  it('picks the next unused ordinal by default', () => {
    const { text } = wrapAsCloze('{{c1::a}} b', 10, 11);
    expect(clozeOrdinals(text)).toEqual([1, 2]);
  });

  it('fills a gap when one exists', () => {
    const { text } = wrapAsCloze('{{c1::a}} {{c3::c}} b', 20, 21);
    expect(clozeOrdinals(text)).toEqual([1, 2, 3]);
  });

  it('adds to the same card when handed the current ordinal', () => {
    const src = '{{c1::a}} b';
    const { text } = wrapAsCloze(src, 10, 11, sameOrdinal(src));
    expect(clozeOrdinals(text)).toEqual([1]);
    expect(parseCloze(text).nodes.filter((n) => n.kind === 'cloze')).toHaveLength(2);
  });

  it('starts at 1 when there is nothing to match', () => {
    expect(sameOrdinal('nothing')).toBe(1);
  });
});

describe('renumberOrdinals', () => {
  it('closes gaps', () => {
    expect(renumberOrdinals('{{c1::a}} {{c3::c}} {{c7::g}}')).toBe(
      '{{c1::a}} {{c2::c}} {{c3::g}}',
    );
  });

  it('leaves a contiguous run untouched', () => {
    const src = '{{c1::a}} {{c2::b}}';
    expect(renumberOrdinals(src)).toBe(src);
  });

  it('keeps repeated ordinals together', () => {
    expect(renumberOrdinals('{{c2::a}} {{c5::b}} {{c2::a}}')).toBe(
      '{{c1::a}} {{c2::b}} {{c1::a}}',
    );
  });

  it('preserves hints and answers exactly', () => {
    const out = renumberOrdinals('{{c4::std\\:\\:vector::a container}}');
    expect(out).toBe('{{c1::std\\:\\:vector::a container}}');
    expect(answerOf(out)).toBe('std::vector');
  });

  it('preserves brace-heavy answers when offsets shift', () => {
    const out = renumberOrdinals('{{c10::\\frac{1}{2}}} and {{c20::x}}');
    expect(out).toBe('{{c1::\\frac{1}{2}}} and {{c2::x}}');
    expect(answerOf(out)).toBe('\\frac{1}{2}');
  });

  it('leaves a note with no deletions alone', () => {
    expect(renumberOrdinals('plain')).toBe('plain');
  });
});
