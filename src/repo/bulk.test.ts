/**
 * Bulk operation tests, against fake-indexeddb like the rest of the repo layer.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import { db } from '../db/db';
import { createDeck } from './decks';
import { cardsForNote } from './cards';
import { createNote, getNote, updateNote } from './notes';
import {
  addTagsToNotes,
  allTags,
  deleteNotes,
  loadBrowseData,
  moveNotes,
  removeTagsFromNotes,
  restoreNotes,
  setNotesSuspended,
} from './bulk';

let a: string;
let b: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  a = (await createDeck({ name: 'A' })).id;
  b = (await createDeck({ name: 'B' })).id;
});

async function make(text: string, tags: string[] = [], deckId = a) {
  return (await createNote({ deckId, text, tags })).note;
}

describe('tags', () => {
  it('adds tags only where missing, and reports how many notes changed', async () => {
    const n1 = await make('{{c1::x}}', ['ad']);
    const n2 = await make('{{c1::y}}');
    expect(await addTagsToNotes([n1.id, n2.id], ['AD', 'new tag'])).toBe(2);
    expect((await getNote(n1.id))!.tags).toEqual(['ad', 'new-tag']); // AD == ad, not a duplicate
    expect((await getNote(n2.id))!.tags).toEqual(['AD', 'new-tag']);
    expect(await addTagsToNotes([n1.id, n2.id], ['new-tag'])).toBe(0);
  });

  it('removes tags case-insensitively', async () => {
    const n1 = await make('{{c1::x}}', ['AD', 'keep']);
    const n2 = await make('{{c1::y}}', ['other']);
    expect(await removeTagsFromNotes([n1.id, n2.id], ['ad'])).toBe(1);
    expect((await getNote(n1.id))!.tags).toEqual(['keep']);
  });

  it('bumps modified on the notes it changes', async () => {
    const n = await make('{{c1::x}}');
    await addTagsToNotes([n.id], ['t'], n.modified + 5000);
    expect((await getNote(n.id))!.modified).toBe(n.modified + 5000);
  });

  it('allTags lists tags across decks, ignoring deleted notes', async () => {
    await make('{{c1::x}}', ['zeta']);
    await make('{{c1::y}}', ['alpha'], b);
    const gone = await make('{{c1::z}}', ['ghost']);
    await deleteNotes([gone.id]);
    expect(await allTags()).toEqual(['alpha', 'zeta']);
  });
});

describe('moveNotes', () => {
  it('moves notes, all their cards (retired too) and their review logs', async () => {
    const n = await make('{{c1::x}} {{c2::y}}');
    // Retire c2, so there is a soft-deleted card to carry along.
    await updateNote(n.id, { text: '{{c1::x}} y' });
    const [live] = await cardsForNote(n.id);
    await db.reviewLogs.add({
      id: 'log1',
      cardId: live.id,
      deckId: a,
      rating: 3,
      state: State.New,
      due: 0,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      lastElapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reviewedAt: Date.now(),
    });

    expect(await moveNotes([n.id], b)).toBe(1);
    expect((await getNote(n.id))!.deckId).toBe(b);
    const all = await cardsForNote(n.id, true);
    expect(all).toHaveLength(2);
    expect(all.every((c) => c.deckId === b)).toBe(true);
    expect((await db.reviewLogs.get('log1'))!.deckId).toBe(b);
  });

  it('skips notes already in the target deck', async () => {
    const here = await make('{{c1::x}}', [], b);
    const there = await make('{{c1::y}}');
    expect(await moveNotes([here.id, there.id], b)).toBe(1);
  });

  it('refuses a deck that does not exist, changing nothing', async () => {
    const n = await make('{{c1::x}}');
    await expect(moveNotes([n.id], 'nope')).rejects.toThrow(/no longer exists/);
    expect((await getNote(n.id))!.deckId).toBe(a);
  });

  it('a restored card after a move lands in the new deck', async () => {
    const n = await make('{{c1::x}} {{c2::y}}');
    await updateNote(n.id, { text: '{{c1::x}} y' }); // retire c2
    await moveNotes([n.id], b);
    await updateNote(n.id, { text: '{{c1::x}} {{c2::y}}' }); // restore c2
    const cards = await cardsForNote(n.id);
    expect(cards.map((c) => [c.ordinal, c.deckId])).toEqual([
      [1, b],
      [2, b],
    ]);
  });
});

describe('suspension', () => {
  it('suspends and unsuspends every live card, counting cards changed', async () => {
    const n1 = await make('{{c1::x}} {{c2::y}}');
    const n2 = await make('{{c1::z}}');
    expect(await setNotesSuspended([n1.id, n2.id], true)).toBe(3);
    expect(await setNotesSuspended([n1.id, n2.id], true)).toBe(0);
    expect((await cardsForNote(n1.id)).every((c) => c.suspended)).toBe(true);
    expect(await setNotesSuspended([n1.id], false)).toBe(2);
  });
});

describe('delete and restore', () => {
  it('soft-deletes notes and cards, and restoring brings back the same cards', async () => {
    const n = await make('{{c1::x}} {{c2::y}}');
    const before = (await cardsForNote(n.id)).map((c) => c.id);

    expect(await deleteNotes([n.id])).toEqual([n.id]);
    expect((await getNote(n.id))!.deletedAt).toBeDefined();
    expect(await cardsForNote(n.id)).toEqual([]);
    expect((await loadBrowseData()).notes).toEqual([]);

    await restoreNotes([n.id]);
    expect((await getNote(n.id))!.deletedAt).toBeUndefined();
    expect((await cardsForNote(n.id)).map((c) => c.id)).toEqual(before);
  });

  it('keeps an already-retired card retired through delete and restore', async () => {
    const n = await make('{{c1::x}} {{c2::y}}');
    await updateNote(n.id, { text: '{{c1::x}} y' });
    await deleteNotes([n.id]);
    await restoreNotes([n.id]);
    expect((await cardsForNote(n.id)).map((c) => c.ordinal)).toEqual([1]);
  });

  it('only reports notes that were actually live', async () => {
    const n = await make('{{c1::x}}');
    await deleteNotes([n.id]);
    expect(await deleteNotes([n.id, 'missing'])).toEqual([]);
  });
});

describe('loadBrowseData', () => {
  it('returns live notes, live cards and all decks', async () => {
    const n = await make('{{c1::x}} {{c2::y}}');
    await updateNote(n.id, { text: '{{c1::x}} y' });
    const data = await loadBrowseData();
    expect(data.notes.map((x) => x.id)).toEqual([n.id]);
    expect(data.cards).toHaveLength(1);
    expect(data.decks.map((d) => d.name).sort()).toEqual(['A', 'B']);
  });
});
