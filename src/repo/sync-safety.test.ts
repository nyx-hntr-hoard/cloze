/**
 * Writes must touch only the fields they mean to change.
 *
 * With sync on, a device often writes based on a copy of a row that another
 * device has since changed. A whole-row `put` would silently revert that
 * other change; a field-level update doesn't. These tests simulate the stale
 * copy locally: read a row, change it "elsewhere", then write from the stale
 * copy — and check the other change survived.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Rating, default_w } from 'ts-fsrs';
import { db } from '../db/db';
import { DEFAULT_FSRS_PARAMS } from '../db/types';
import { answerCard, makeScheduler, undoAnswer } from '../review/scheduler';
import { addTagsToNotes, moveNotes } from './bulk';
import { cardsForNote, setSuspended } from './cards';
import { createDeck } from './decks';
import { createNote, getNote, updateNote } from './notes';
import { applyWeights } from './stats';

let deckA: string;
let deckB: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  deckA = (await createDeck({ name: 'A' })).id;
  deckB = (await createDeck({ name: 'B' })).id;
});

describe('field-level writes', () => {
  it('answering from a stale card keeps a suspension made meanwhile', async () => {
    const { note } = await createNote({ deckId: deckA, text: '{{c1::x}}' });
    const [stale] = await cardsForNote(note.id);
    await setSuspended([stale.id], true); // "another device"
    await answerCard(makeScheduler(DEFAULT_FSRS_PARAMS), stale, Rating.Good);
    const after = await db.cards.get(stale.id);
    expect(after!.suspended).toBe(true);
    expect(after!.reps).toBe(1);
  });

  it('undo restores the schedule, including removing lastReview, and nothing else', async () => {
    const { note } = await createNote({ deckId: deckA, text: '{{c1::x}}' });
    const [card] = await cardsForNote(note.id);
    const result = await answerCard(makeScheduler(DEFAULT_FSRS_PARAMS), card, Rating.Good);
    await setSuspended([card.id], true);
    await undoAnswer(result);
    const after = await db.cards.get(card.id);
    expect(after!.reps).toBe(0);
    expect('lastReview' in after!).toBe(false);
    expect(after!.suspended).toBe(true);
  });

  it('moving a note keeps a review answered meanwhile', async () => {
    const { note } = await createNote({ deckId: deckA, text: '{{c1::x}}' });
    const [card] = await cardsForNote(note.id);
    await answerCard(makeScheduler(DEFAULT_FSRS_PARAMS), card, Rating.Good);
    await moveNotes([note.id], deckB);
    const after = await db.cards.get(card.id);
    expect(after!.deckId).toBe(deckB);
    expect(after!.reps).toBe(1);
  });

  it('applying weights changes only stability and difficulty', async () => {
    const { note } = await createNote({ deckId: deckA, text: '{{c1::x}}' });
    const [card] = await cardsForNote(note.id);
    const { card: answered } = await answerCard(makeScheduler(DEFAULT_FSRS_PARAMS), card, Rating.Good, Date.now() - 5 * 86_400_000);
    await answerCard(makeScheduler(DEFAULT_FSRS_PARAMS), answered, Rating.Good);
    const before = await db.cards.get(card.id);
    await applyWeights(default_w.map((v, j) => (j < 4 ? v * 2 : v)));
    const after = await db.cards.get(card.id);
    expect({ ...after, stability: 0, difficulty: 0 }).toEqual({ ...before, stability: 0, difficulty: 0 });
  });

  it('bulk tagging keeps an edit to the note text made meanwhile', async () => {
    const { note } = await createNote({ deckId: deckA, text: '{{c1::x}}' });
    await updateNote(note.id, { text: '{{c1::y}}' });
    await addTagsToNotes([note.id], ['t']);
    const after = await getNote(note.id);
    expect(after!.text).toBe('{{c1::y}}');
    expect(after!.tags).toEqual(['t']);
  });

  it('switching a basic note to cloze removes back and reverse from the row', async () => {
    const { note } = await createNote({ deckId: deckA, type: 'basic', text: 'Q', back: 'A', reverse: true });
    await updateNote(note.id, { type: 'cloze', text: '{{c1::Q}}' });
    const row = await getNote(note.id);
    expect('back' in row!).toBe(false);
    expect('reverse' in row!).toBe(false);
    expect('type' in row!).toBe(false);
  });
});
