/**
 * Note-type tests.
 *
 * Two claims matter here. First, that basic notes ride on the machinery cloze
 * notes already use, so turning the reverse card off retires it and keeps its
 * history exactly as removing a `{{c2::…}}` does. Second, that adding a type
 * changed nothing for notes that never had one — every existing note and every
 * existing backup is a cloze note, and must stay one.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import { segmentsToText } from './cloze';
import { db } from './db/db';
import {
  cardAnswerText,
  diagnoseNote,
  draftFromNote,
  noteHashSource,
  noteSummaryOf,
  noteTypeOf,
  ordinalsForNote,
  renderNoteCard,
  renderNoteCards,
  summarizeNote,
} from './notetypes';
import { cardsForNote, createDeck, createNote, DEFAULT_FSRS_PARAMS, updateNote } from './repo';
import { answerCard, makeScheduler } from './review';

const scheduler = makeScheduler(DEFAULT_FSRS_PARAMS);
const basic = (text: string, back: string, reverse = false) =>
  ({ type: 'basic' as const, text, back, reverse });

let deckId: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  deckId = (await createDeck({ name: 'Acronyms' })).id;
});

// ---------------------------------------------------------------------------
// Type defaulting
// ---------------------------------------------------------------------------

describe('type defaulting', () => {
  it('treats a note with no type as cloze', () => {
    expect(noteTypeOf({ text: '{{c1::a}}' })).toBe('cloze');
    expect(ordinalsForNote({ text: '{{c1::a}} {{c2::b}}' })).toEqual([1, 2]);
  });

  it('does not store a type on a cloze note', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}}' });
    const stored = await db.notes.get(note.id);
    expect(stored!.type).toBeUndefined();
    expect(stored!.back).toBeUndefined();
    expect(stored!.reverse).toBeUndefined();
  });

  it('drops basic-only fields if a note is switched back to cloze', async () => {
    const { note } = await createNote({ ...basic('SPN', 'Service Principal Name'), deckId });
    await updateNote(note.id, { type: 'cloze', text: '{{c1::SPN}}' });

    const stored = await db.notes.get(note.id);
    expect(stored!.type).toBeUndefined();
    expect(stored!.back).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Card generation
// ---------------------------------------------------------------------------

describe('basic card generation', () => {
  it('makes one card', async () => {
    const { note } = await createNote({ ...basic('SPN', 'Service Principal Name'), deckId });
    expect((await cardsForNote(note.id)).map((c) => c.ordinal)).toEqual([1]);
  });

  it('makes two when asked backwards', async () => {
    const { note } = await createNote({ ...basic('SPN', 'Service Principal Name', true), deckId });
    expect((await cardsForNote(note.id)).map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('makes none until both sides are filled in', () => {
    expect(ordinalsForNote(basic('', 'back'))).toEqual([]);
    expect(ordinalsForNote(basic('front', ''))).toEqual([]);
    expect(ordinalsForNote(basic('   ', '   '))).toEqual([]);
    expect(ordinalsForNote(basic('front', 'back'))).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('basic rendering', () => {
  const note = basic('SPN', 'Service Principal Name', true);

  it('asks the front and answers with the back', () => {
    const card = renderNoteCard(note, 1);
    expect(segmentsToText(card.front)).toBe('SPN');
    expect(cardAnswerText(card)).toBe('Service Principal Name');
  });

  it('reverses on card 2', () => {
    const card = renderNoteCard(note, 2);
    expect(segmentsToText(card.front)).toBe('Service Principal Name');
    expect(cardAnswerText(card)).toBe('SPN');
  });

  it('keeps the question visible on the back, below a rule', () => {
    const card = renderNoteCard(note, 1);
    expect(card.back.map((s) => s.kind)).toEqual(['text', 'divider', 'text']);
    expect(segmentsToText(card.back)).toContain('SPN');
    expect(segmentsToText(card.back)).toContain('Service Principal Name');
  });

  it('renders both cards in ordinal order', () => {
    expect(renderNoteCards(note).map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('still reads answers out of a cloze card', () => {
    const card = renderNoteCard({ text: 'The capital is {{c1::Paris}}' }, 1);
    expect(cardAnswerText(card)).toBe('Paris');
  });

  it('summarises with an arrow rather than a blanked sentence', () => {
    expect(noteSummaryOf(note)).toBe('SPN → Service Principal Name');
    expect(noteSummaryOf({ text: 'Capital is {{c1::Paris}}' })).toBe('Capital is Paris');
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — the reason basic rides on ordinals
// ---------------------------------------------------------------------------

describe('turning the reverse card off and on', () => {
  it('retires card 2 and keeps its history, then restores it', async () => {
    const { note } = await createNote({ ...basic('SPN', 'Service Principal Name', true), deckId });
    const before = await cardsForNote(note.id);
    expect(before).toHaveLength(2);

    // Study the reverse card so there is history worth protecting.
    await answerCard(scheduler, before[1], Rating.Good, Date.now());
    const studied = (await cardsForNote(note.id))[1];
    expect(studied.reps).toBe(1);

    await updateNote(note.id, { reverse: false });
    expect((await cardsForNote(note.id)).map((c) => c.ordinal)).toEqual([1]);
    expect((await db.cards.get(studied.id))!.deletedAt).toBeTypeOf('number');
    expect((await db.cards.get(studied.id))!.reps).toBe(1);

    await updateNote(note.id, { reverse: true });
    const after = await cardsForNote(note.id);
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after[1].reps).toBe(1);
  });

  it('retires everything when a side is emptied, and brings it back', async () => {
    const { note } = await createNote({ ...basic('SPN', 'Service Principal Name'), deckId });
    const [card] = await cardsForNote(note.id);

    await updateNote(note.id, { back: '' });
    expect(await cardsForNote(note.id)).toHaveLength(0);

    await updateNote(note.id, { back: 'Service Principal Name' });
    expect((await cardsForNote(note.id))[0].id).toBe(card.id);
  });

  it('keeps card 1 when a cloze note is switched to basic', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::SPN}}' });
    const [card] = await cardsForNote(note.id);

    await updateNote(note.id, { type: 'basic', text: 'SPN', back: 'Service Principal Name' });
    const after = await cardsForNote(note.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(card.id);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('diagnostics', () => {
  const codes = (n: Parameters<typeof diagnoseNote>[0]) => diagnoseNote(n).map((d) => d.code);

  it('blocks a half-written basic note', () => {
    expect(codes(basic('SPN', ''))).toContain('empty-back');
    expect(codes(basic('', 'Service Principal Name'))).toContain('empty-front');
    expect(summarizeNote(basic('SPN', '')).hasError).toBe(true);
  });

  it('is happy with a complete one', () => {
    expect(diagnoseNote(basic('SPN', 'Service Principal Name'))).toEqual([]);
    expect(summarizeNote(basic('SPN', 'Service Principal Name')).hasError).toBe(false);
  });

  it('warns about cloze markup on a basic note without blocking the save', () => {
    const note = basic('{{c1::SPN}}', 'Service Principal Name');
    expect(codes(note)).toContain('cloze-in-basic');
    expect(summarizeNote(note).hasError).toBe(false);
  });

  it('does not apply cloze diagnostics to a basic note', () => {
    // "no deletions here" is meaningless advice on a basic card.
    expect(codes(basic('SPN', 'Service Principal Name'))).not.toContain('no-cloze');
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('de-duplication', () => {
  it('distinguishes basic notes that share a front', () => {
    const a = noteHashSource(basic('TGT', 'Ticket Granting Ticket'));
    const b = noteHashSource(basic('TGT', 'Ticket Granting Service'));
    expect(a).not.toBe(b);
  });

  it('does not confuse a basic note with a cloze note of the same text', () => {
    expect(noteHashSource(basic('SPN', 'x'))).not.toBe(noteHashSource({ text: 'SPN' }));
  });

  it('stores different hashes for two same-front notes', async () => {
    const one = await createNote({ ...basic('TGT', 'Ticket Granting Ticket'), deckId });
    const two = await createNote({ ...basic('TGT', 'Ticket Granting Service'), deckId });
    expect(one.note.contentHash).not.toBe(two.note.contentHash);
  });
});

describe('draftFromNote', () => {
  it('round-trips a basic note through the editor shape', async () => {
    const { note } = await createNote({
      ...basic('SPN', 'Service Principal Name', true),
      deckId,
      extra: 'seen in Kerberoasting',
      tags: ['ad'],
    });
    expect(draftFromNote((await db.notes.get(note.id))!)).toEqual({
      type: 'basic',
      text: 'SPN',
      back: 'Service Principal Name',
      reverse: true,
      extra: 'seen in Kerberoasting',
      tags: ['ad'],
    });
  });

  it('fills in the missing fields for a cloze note', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}}' });
    expect(draftFromNote((await db.notes.get(note.id))!)).toMatchObject({
      type: 'cloze',
      back: '',
      reverse: false,
    });
  });
});
