import { describe, expect, it } from 'vitest';
import { parseCsv } from './parse';
import { csvField, serializeCsv } from './serialize';

describe('parseCsv', () => {
  it('parses a simple multi-row file', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('does not invent a trailing blank row from a final newline', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });

  it('handles a final row with no trailing newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('treats a blank line as a one-column row with an empty field', () => {
    expect(parseCsv('a,b\n\nc,d\n')).toEqual([['a', 'b'], [''], ['c', 'd']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles a lone CR as a line ending', () => {
    expect(parseCsv('a,b\rc,d\r')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n')).toEqual([['a', 'b']]);
  });

  it('keeps a comma inside a quoted field literal', () => {
    expect(parseCsv('"a,b",c\n')).toEqual([['a,b', 'c']]);
  });

  it('keeps a newline inside a quoted field literal', () => {
    expect(parseCsv('"line one\nline two",c\n')).toEqual([['line one\nline two', 'c']]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsv('"He said ""hi""",c\n')).toEqual([['He said "hi"', 'c']]);
  });

  it('keeps a stray quote mid-field literal rather than entering quote mode', () => {
    expect(parseCsv('3" screen,ok\n')).toEqual([['3" screen', 'ok']]);
  });

  it('appends literal text that follows a closed quoted field', () => {
    // Malformed by strict RFC 4180, but real-world files do this; a lenient
    // reader should not lose the trailing characters.
    expect(parseCsv('"abc"def,g\n')).toEqual([['abcdef', 'g']]);
  });

  it('does not crash on ragged rows with differing column counts', () => {
    expect(parseCsv('a,b,c\n1,2\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
    ]);
  });

  it('handles an empty field', () => {
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
});

describe('csvField', () => {
  it('leaves a plain value unquoted', () => {
    expect(csvField('hello')).toBe('hello');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('a,b')).toBe('"a,b"');
  });

  it('quotes and escapes a value containing a quote', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a value containing a newline', () => {
    expect(csvField('a\nb')).toBe('"a\nb"');
  });
});

describe('parseCsv(serializeCsv(...))', () => {
  const cases: string[][][] = [
    [['a', 'b'], ['c', 'd']],
    [['has,comma', 'plain']],
    [['has "quote"', 'plain']],
    [['has\nnewline', 'plain']],
    [['', '']],
    [['unicode: café', '日本語']],
  ];

  for (const rows of cases) {
    it(`round-trips ${JSON.stringify(rows)}`, () => {
      expect(parseCsv(serializeCsv(rows))).toEqual(rows);
    });
  }

  it('round-trips an empty table as nothing', () => {
    expect(serializeCsv([])).toBe('');
    expect(parseCsv(serializeCsv([]))).toEqual([]);
  });
});
