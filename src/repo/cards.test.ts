/**
 * Reconciliation tests.
 *
 * These run against fake-indexeddb rather than mocks: the soft-delete and
 * restore behaviour depends on how Dexie round-trips rows, so mocking the
 * store would test the wrong thing.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { createNote, deleteNote, restoreNote, updateNote } from './notes';
import { cardsForNote, reconcileCards } from './cards';
import { createDeck } from './decks';

let deckId: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  const deck = await createDeck({ name: 'Test' });
  deckId = deck.id;
});

/**
 * The grammar itself is tested in `src/cloze`. What matters here is that the
 * parser's answers actually reach card generation — the seam where a wrong
 * ordinal set would silently retire real cards.
 */
describe('card generation through the parser', () => {
  it('does not split a LaTeX answer into two cards', () => {
    return createNote({ deckId, text: 'Half is {{c1::\\frac{1}{2}}} exactly' }).then(
      async ({ note }) => {
        expect((await cardsForNote(note.id)).map((c) => c.ordinal)).toEqual([1]);
      },
    );
  });

  it('treats an escaped :: as part of the answer, not a hint', async () => {
    const { note, diagnostics } = await createNote({
      deckId,
      text: 'Use {{c1::[Net.WebClient]\\:\\:DownloadString}} to fetch',
    });
    expect(diagnostics).toEqual([]);
    expect(await cardsForNote(note.id)).toHaveLength(1);
  });

  it('generates no cards for a nested deletion and reports the error', async () => {
    const { note, diagnostics } = await createNote({
      deckId,
      text: '{{c1::a {{c2::b}} c}}',
    });
    expect(await cardsForNote(note.id)).toHaveLength(0);
    expect(diagnostics.map((d) => d.code)).toContain('nested-cloze');
  });

  it('skips c0 but keeps the valid deletions beside it', async () => {
    const { note } = await createNote({ deckId, text: '{{c0::x}} {{c2::y}} {{c1::z}}' });
    expect((await cardsForNote(note.id)).map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('reports diagnostics on update as well as create', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}}' });
    const { diagnostics } = await updateNote(note.id, { text: '{{c1::a' });
    expect(diagnostics.map((d) => d.code)).toContain('unclosed-cloze');
  });

  it('retires only the broken deletion mid-edit, and restores it on repair', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const before = (await cardsForNote(note.id)).map((c) => c.id);
    await db.cards.update(before[1], { reps: 12 });

    // Mid-keystroke: c2's closing braces are not typed yet. c1 is untouched by
    // the damage, so its card must survive; only c2 is retired.
    await updateNote(note.id, { text: '{{c1::a}} {{c2::b' });
    const during = await cardsForNote(note.id);
    expect(during.map((c) => c.ordinal)).toEqual([1]);
    expect(during[0].id).toBe(before[0]);

    await updateNote(note.id, { text: '{{c1::a}} {{c2::b}}' });
    const after = await cardsForNote(note.id);
    expect(after.map((c) => c.id)).toEqual(before);
    expect(after[1].reps).toBe(12);
  });

  it('retires every card when an edit breaks the first deletion', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const before = (await cardsForNote(note.id)).map((c) => c.id);

    // An unclosed deletion swallows the rest of the note, so both are retired —
    // and both come back, with their history, the moment it is closed again.
    await updateNote(note.id, { text: '{{c1::a {{c2::b}}' });
    expect(await cardsForNote(note.id)).toHaveLength(0);

    await updateNote(note.id, { text: '{{c1::a}} {{c2::b}}' });
    expect((await cardsForNote(note.id)).map((c) => c.id)).toEqual(before);
  });
});

describe('reconcileCards', () => {
  it('creates one card per ordinal', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const cards = await cardsForNote(note.id);
    expect(cards.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('adds a card when a new ordinal appears, leaving the others alone', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}}' });
    const [before] = await cardsForNote(note.id);

    await updateNote(note.id, { text: '{{c1::a}} {{c2::b}}' });
    const after = await cardsForNote(note.id);

    expect(after.map((c) => c.ordinal)).toEqual([1, 2]);
    expect(after[0].id).toBe(before.id);
  });

  it('soft-deletes rather than destroys a card whose ordinal disappears', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const [, c2] = await cardsForNote(note.id);

    // Simulate accumulated review history.
    await db.cards.update(c2.id, { reps: 9, lapses: 2, stability: 31.5 });

    await updateNote(note.id, { text: '{{c1::a}}' });

    expect((await cardsForNote(note.id)).map((c) => c.ordinal)).toEqual([1]);

    const stored = await db.cards.get(c2.id);
    expect(stored).toBeDefined();
    expect(stored!.deletedAt).toBeTypeOf('number');
    expect(stored!.reps).toBe(9);
  });

  it('restores the original card — with its history — when an ordinal comes back', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const [, c2] = await cardsForNote(note.id);
    await db.cards.update(c2.id, { reps: 9, stability: 31.5 });

    await updateNote(note.id, { text: '{{c1::a}}' });
    await updateNote(note.id, { text: '{{c1::a}} {{c2::b}}' });

    const after = await cardsForNote(note.id);
    expect(after).toHaveLength(2);

    const restored = after.find((c) => c.ordinal === 2)!;
    expect(restored.id).toBe(c2.id);
    expect(restored.reps).toBe(9);
    expect(restored.stability).toBe(31.5);
    expect(restored.deletedAt).toBeUndefined();
  });

  it('does not create a duplicate when an ordinal is restored', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    await updateNote(note.id, { text: '{{c1::a}}' });
    await updateNote(note.id, { text: '{{c1::a}} {{c2::b}}' });

    const all = await db.cards.where('noteId').equals(note.id).toArray();
    expect(all).toHaveLength(2);
  });

  it('treats renumbering conservatively: c1 keeps its history, c2 is retired', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const [c1, c2] = await cardsForNote(note.id);
    await db.cards.update(c1.id, { reps: 4 });
    await db.cards.update(c2.id, { reps: 7 });

    // The author deletes the c1 deletion and renumbers c2 down to c1.
    await updateNote(note.id, { text: 'a {{c1::b}}' });

    const after = await cardsForNote(note.id);
    expect(after.map((c) => c.ordinal)).toEqual([1]);
    expect(after[0].id).toBe(c1.id);
    expect(after[0].reps).toBe(4);
    expect((await db.cards.get(c2.id))!.deletedAt).toBeTypeOf('number');
  });

  it('is idempotent', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const first = await cardsForNote(note.id);

    await reconcileCards(note.id, deckId, [1, 2]);
    await reconcileCards(note.id, deckId, [1, 2]);

    const second = await cardsForNote(note.id);
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it('follows the note when it moves to another deck', async () => {
    const other = await createDeck({ name: 'Other' });
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });

    await updateNote(note.id, { deckId: other.id });

    const after = await cardsForNote(note.id);
    expect(after.every((c) => c.deckId === other.id)).toBe(true);
  });

  it('drops every card when the last deletion is removed', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}}' });
    await updateNote(note.id, { text: 'no cloze here' });
    expect(await cardsForNote(note.id)).toHaveLength(0);
  });
});

describe('note soft delete', () => {
  it('hides a note and its cards, then brings both back', async () => {
    const { note } = await createNote({ deckId, text: '{{c1::a}} {{c2::b}}' });
    const ids = (await cardsForNote(note.id)).map((c) => c.id);

    await deleteNote(note.id);
    expect(await cardsForNote(note.id)).toHaveLength(0);
    expect((await db.notes.get(note.id))!.deletedAt).toBeTypeOf('number');

    await restoreNote(note.id);
    const after = await cardsForNote(note.id);
    expect(after.map((c) => c.id).sort()).toEqual(ids.sort());
    expect((await db.notes.get(note.id))!.deletedAt).toBeUndefined();
  });
});
