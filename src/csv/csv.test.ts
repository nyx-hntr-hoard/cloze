/**
 * CSV import/export tests against a real (fake-indexeddb) deck.
 *
 * The pure parsing/mapping logic is covered in parse.test.ts and
 * mapping.test.ts; this file is about the layer that actually touches notes
 * and cards — planning agreeing with committing, deduplication against what
 * is already in the deck, and the round trip through export and back.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { cardsForNote, createDeck, createNote, deleteNote, notesInDeck } from '../repo';
import { mapRows, type ColumnField } from './mapping';
import { parseCsv } from './parse';
import { importCsv, planCsvImport } from './importer';
import { exportDeckCsv, notesToCsvText } from './exporter';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('planCsvImport / importCsv (basic)', () => {
  async function setup() {
    const deck = await createDeck({ name: 'Acronyms' });
    await createNote({ deckId: deck.id, type: 'basic', text: 'SPN', back: 'Service Principal Name' });
    return deck;
  }

  const rows = [
    ['SPN', 'Service Principal Name'], // duplicate of the seeded note
    ['TGT', 'Ticket Granting Ticket'],
    ['', 'blank front'],
    ['TGT', 'Ticket Granting Ticket'], // duplicate within the file itself
    ['LSA', ''], // blank back
  ];
  const mapping: ColumnField[] = ['text', 'back'];

  it('plan and import agree on the same counts', async () => {
    const deck = await setup();
    const mapped = mapRows(rows, { type: 'basic', mapping, defaultReverse: false });

    const plan = await planCsvImport(deck.id, 'basic', mapped, true);
    expect(plan).toEqual({ totalRows: 5, toImport: 1, blank: 2, duplicates: 2 });

    const result = await importCsv(deck.id, 'basic', mapped, true);
    expect(result).toEqual({
      notesImported: 1,
      cardsImported: 1,
      blankSkipped: 2,
      duplicatesSkipped: 2,
      noCards: 0,
    });

    const notes = await notesInDeck(deck.id);
    expect(notes.map((n) => n.text).sort()).toEqual(['SPN', 'TGT']);
  });

  it('imports every non-blank row when duplicate skipping is off', async () => {
    const deck = await setup();
    const mapped = mapRows(rows, { type: 'basic', mapping, defaultReverse: false });

    const result = await importCsv(deck.id, 'basic', mapped, false);
    // 5 rows, 2 blank (empty front or back), 3 otherwise importable.
    expect(result).toEqual({
      notesImported: 3,
      cardsImported: 3,
      blankSkipped: 2,
      duplicatesSkipped: 0,
      noCards: 0,
    });
  });

  it('generates a reverse card from a per-row reverse column', async () => {
    const deck = await createDeck({ name: 'Bidirectional' });
    const mapped = mapRows([['A', 'alpha', 'yes'], ['B', 'beta', 'no']], {
      type: 'basic',
      mapping: ['text', 'back', 'reverse'],
      defaultReverse: false,
    });

    const result = await importCsv(deck.id, 'basic', mapped, false);
    expect(result).toEqual({
      notesImported: 2,
      cardsImported: 3, // 2 for the reversed note, 1 for the other
      blankSkipped: 0,
      duplicatesSkipped: 0,
      noCards: 0,
    });
  });

  it('splits a tags cell on commas, semicolons and whitespace alike', async () => {
    const deck = await createDeck({ name: 'Tagged' });
    const mapped = mapRows([['A', 'a', 'one, two;three four']], {
      type: 'basic',
      mapping: ['text', 'back', 'tags'],
      defaultReverse: false,
    });

    await importCsv(deck.id, 'basic', mapped, false);
    const [note] = await notesInDeck(deck.id);
    expect(note.tags).toEqual(['four', 'one', 'three', 'two']); // cleanTags sorts them
  });
});

describe('planCsvImport / importCsv (cloze)', () => {
  it('counts a cloze row with no deletions as imported but cardless', async () => {
    const deck = await createDeck({ name: 'Cloze import' });
    const mapped = mapRows([['{{c1::a}}'], ['no markup here']], {
      type: 'cloze',
      mapping: ['text'],
      defaultReverse: false,
    });

    const result = await importCsv(deck.id, 'cloze', mapped, false);
    expect(result).toEqual({
      notesImported: 2,
      cardsImported: 1,
      blankSkipped: 0,
      duplicatesSkipped: 0,
      noCards: 1,
    });
  });
});

describe('exportDeckCsv / notesToCsvText', () => {
  it('exports live notes only, with type/back/reverse/extra/tags', async () => {
    const deck = await createDeck({ name: 'Mixed' });
    await createNote({ deckId: deck.id, text: '{{c1::x}}', extra: 'ctx', tags: ['a', 'b'] });
    const { note: toDelete } = await createNote({ deckId: deck.id, text: '{{c1::y}}' });
    await deleteNote(toDelete.id);
    await createNote({ deckId: deck.id, type: 'basic', text: 'front', back: 'back', reverse: true });

    const notes = await notesInDeck(deck.id);
    const rows = parseCsv(notesToCsvText(notes));

    expect(rows[0]).toEqual(['type', 'text', 'back', 'reverse', 'extra', 'tags']);
    expect(rows).toHaveLength(3); // header + 2 live notes, the deleted one excluded
    expect(rows).toContainEqual(['cloze', '{{c1::x}}', '', 'false', 'ctx', 'a b']);
    expect(rows).toContainEqual(['basic', 'front', 'back', 'true', '', '']);
  });

  it('quotes fields that contain the delimiter', async () => {
    const deck = await createDeck({ name: 'Quoting' });
    await createNote({ deckId: deck.id, type: 'basic', text: 'a, b', back: 'c "d"' });

    const text = notesToCsvText(await notesInDeck(deck.id));
    expect(text).toContain('"a, b"');
    expect(text).toContain('"c ""d"""');
  });

  it('produces a filename and blob via exportDeckCsv', async () => {
    const deck = await createDeck({ name: 'My Deck!' });
    await createNote({ deckId: deck.id, type: 'basic', text: 'a', back: 'b' });

    const file = await exportDeckCsv(deck.id);
    expect(file.filename).toMatch(/^cloze-my-deck-\d{4}-\d\d-\d\d-\d{4}\.csv$/);
    expect(file.rowCount).toBe(1);
    expect(file.blob.type).toBe('text/csv;charset=utf-8');
  });
});

describe('round trip: export a deck, import the file into a new one', () => {
  it('preserves text, back, reverse, extra and tags for a basic deck', async () => {
    const source = await createDeck({ name: 'Source' });
    await createNote({
      deckId: source.id,
      type: 'basic',
      text: 'SPN',
      back: 'Service Principal Name',
      extra: 'Used in Kerberoasting',
      tags: ['ad', 'kerberos'],
    });
    await createNote({
      deckId: source.id,
      type: 'basic',
      text: 'front',
      back: 'back',
      reverse: true,
    });

    const csvText = notesToCsvText(await notesInDeck(source.id));
    const rows = parseCsv(csvText);
    const [header, ...dataRows] = rows;
    // The exporter's own header order: type, text, back, reverse, extra, tags.
    // Importing skips the "type" column since the whole file is one type.
    expect(header).toEqual(['type', 'text', 'back', 'reverse', 'extra', 'tags']);
    const mapping: ColumnField[] = ['ignore', 'text', 'back', 'reverse', 'extra', 'tags'];

    const target = await createDeck({ name: 'Target' });
    const mapped = mapRows(dataRows, { type: 'basic', mapping, defaultReverse: false });
    await importCsv(target.id, 'basic', mapped, false);

    const imported = await notesInDeck(target.id);
    expect(imported).toHaveLength(2);

    const spn = imported.find((n) => n.text === 'SPN')!;
    expect(spn.back).toBe('Service Principal Name');
    expect(spn.extra).toBe('Used in Kerberoasting');
    expect(spn.tags).toEqual(['ad', 'kerberos']);
    expect((await cardsForNote(spn.id)).length).toBe(1);

    const reversed = imported.find((n) => n.text === 'front')!;
    expect(reversed.back).toBe('back');
    expect(reversed.reverse).toBe(true);
    expect((await cardsForNote(reversed.id)).length).toBe(2);
  });
});
