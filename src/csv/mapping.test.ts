import { describe, expect, it } from 'vitest';
import { fieldsFor, guessMapping, mapRow, mapRows, type ColumnField } from './mapping';

describe('fieldsFor', () => {
  it('cloze does not offer back or reverse', () => {
    const fields = fieldsFor('cloze').map((f) => f.field);
    expect(fields).toContain('text');
    expect(fields).not.toContain('back');
    expect(fields).not.toContain('reverse');
  });

  it('basic offers front, back and reverse', () => {
    const fields = fieldsFor('basic').map((f) => f.field);
    expect(fields).toEqual(['ignore', 'text', 'back', 'extra', 'tags', 'reverse']);
  });
});

describe('guessMapping', () => {
  it('maps common header names for a basic import', () => {
    expect(guessMapping(['Front', 'Back', 'Tags'], 'basic')).toEqual(['text', 'back', 'tags']);
  });

  it('recognizes alternate header names', () => {
    expect(guessMapping(['Question', 'Answer', 'Notes'], 'basic')).toEqual(['text', 'back', 'extra']);
  });

  it('does not guess back for a cloze import even if the header says so', () => {
    // Cloze has no "back" field, so a "Back" column is left unmapped rather
    // than guessing something invalid.
    expect(guessMapping(['Text', 'Back'], 'cloze')).toEqual(['text', 'ignore']);
  });

  it('leaves genuinely unrecognized headers unmapped', () => {
    expect(guessMapping(['Column A', 'Column B'], 'basic')).toEqual(['ignore', 'ignore']);
  });

  it('recognizes "acronym" and "definition" as front/back columns', () => {
    // Pinned explicitly: this is exactly the acronym-deck header that
    // motivated adding the Basic note type in the first place.
    expect(guessMapping(['Acronym', 'Definition'], 'basic')).toEqual(['text', 'back']);
  });

  it('never assigns the same field to two columns', () => {
    expect(guessMapping(['Front', 'Question'], 'basic')).toEqual(['text', 'ignore']);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(guessMapping([' FRONT ', 'back'], 'basic')).toEqual(['text', 'back']);
  });
});

describe('mapRow', () => {
  const basic = (mapping: ColumnField[], defaultReverse = false) => ({
    type: 'basic' as const,
    mapping,
    defaultReverse,
  });
  const cloze = (mapping: ColumnField[]) => ({ type: 'cloze' as const, mapping, defaultReverse: false });

  it('reads front and back from mapped columns', () => {
    const row = mapRow(['SPN', 'Service Principal Name'], 0, basic(['text', 'back']));
    expect(row).toMatchObject({ text: 'SPN', back: 'Service Principal Name', blank: false });
  });

  it('flags a basic row blank when either side is empty', () => {
    expect(mapRow(['SPN', ''], 0, basic(['text', 'back'])).blank).toBe(true);
    expect(mapRow(['', 'Service Principal Name'], 0, basic(['text', 'back'])).blank).toBe(true);
    expect(mapRow(['', ''], 0, basic(['text', 'back'])).blank).toBe(true);
  });

  it('flags a cloze row blank only when the text is empty', () => {
    expect(mapRow([''], 0, cloze(['text'])).blank).toBe(true);
    expect(mapRow(['{{c1::x}}'], 0, cloze(['text'])).blank).toBe(false);
  });

  it('splits tags on commas, semicolons and whitespace', () => {
    const row = mapRow(['a', 'b', 'one, two;three four'], 0, basic(['text', 'back', 'tags']));
    expect(row.tags).toEqual(['one', 'two', 'three', 'four']);
  });

  it('ignores an unmapped column', () => {
    const row = mapRow(['a', 'b', 'unused'], 0, basic(['text', 'back', 'ignore']));
    expect(row.extra).toBe('');
    expect(row.tags).toEqual([]);
  });

  it('falls back to the default reverse flag when no column is mapped to it', () => {
    expect(mapRow(['a', 'b'], 0, basic(['text', 'back'], true)).reverse).toBe(true);
    expect(mapRow(['a', 'b'], 0, basic(['text', 'back'], false)).reverse).toBe(false);
  });

  it('reads a per-row reverse column over the default', () => {
    const mapping: ColumnField[] = ['text', 'back', 'reverse'];
    expect(mapRow(['a', 'b', 'yes'], 0, basic(mapping, false)).reverse).toBe(true);
    expect(mapRow(['a', 'b', 'no'], 0, basic(mapping, true)).reverse).toBe(false);
    expect(mapRow(['a', 'b', ''], 0, basic(mapping, true)).reverse).toBe(false);
    expect(mapRow(['a', 'b', 'FALSE'], 0, basic(mapping, true)).reverse).toBe(false);
  });

  it('is always non-reversed for a cloze row', () => {
    expect(mapRow(['{{c1::x}}'], 0, cloze(['text'])).reverse).toBe(false);
  });

  it('takes the first column when a field is mapped twice', () => {
    const row = mapRow(['first', 'second'], 0, basic(['text', 'text']));
    expect(row.text).toBe('first');
  });

  it('trims whitespace from every field', () => {
    const row = mapRow(['  a  ', '  b  '], 0, basic(['text', 'back']));
    expect(row).toMatchObject({ text: 'a', back: 'b' });
  });
});

describe('mapRows', () => {
  it('maps every row and numbers them from zero', () => {
    const rows = mapRows(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      { type: 'basic', mapping: ['text', 'back'], defaultReverse: false },
    );
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    expect(rows.map((r) => r.text)).toEqual(['a', 'c']);
  });
});
