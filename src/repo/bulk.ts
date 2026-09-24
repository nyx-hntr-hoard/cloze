/**
 * Many-note operations for the browse screen.
 *
 * Each one is a single transaction, so a bulk action either lands on every
 * selected note or on none of them — a half-moved selection is worse than an
 * error. And each writes only the fields it changes, never whole rows, so
 * with sync on it can't revert an edit another device made meanwhile. None of them change note *content*, so none of them need card
 * reconciliation, except restore, which goes back through `restoreNote`.
 *
 * Every function returns how many notes it actually changed, so the screen can
 * say "Tagged 12 notes (3 already had it)" rather than guess.
 */

import { db } from '../db/db';
import type { Card, Deck, Millis, Note } from '../db/types';
import { cleanTags, restoreNote } from './notes';

/**
 * Everything browse indexes, in one read. Live notes and live cards only;
 * decks for their names. Wrapped in `useLiveQuery`, so any write anywhere —
 * including the bulk actions below — re-runs the search.
 */
export async function loadBrowseData(): Promise<{ notes: Note[]; cards: Card[]; decks: Deck[] }> {
  const [notes, cards, decks] = await Promise.all([
    db.notes.filter((n) => !n.deletedAt).toArray(),
    db.cards.filter((c) => !c.deletedAt).toArray(),
    db.decks.toArray(),
  ]);
  return { notes, cards, decks };
}

/** Every tag in use anywhere, for suggestions. */
export async function allTags(): Promise<string[]> {
  const seen = new Set<string>();
  await db.notes.each((n) => {
    if (n.deletedAt) return;
    for (const t of n.tags) seen.add(t);
  });
  return [...seen].sort((a, b) => a.localeCompare(b));
}

async function liveNotes(ids: string[]): Promise<Note[]> {
  const rows = await db.notes.where('id').anyOf(ids).toArray();
  return rows.filter((n) => !n.deletedAt);
}

export async function addTagsToNotes(ids: string[], tags: string[], now: Millis = Date.now()): Promise<number> {
  const add = cleanTags(tags);
  if (!add.length || !ids.length) return 0;

  return db.transaction('rw', db.notes, async () => {
    const changed: Note[] = [];
    for (const note of await liveNotes(ids)) {
      const lower = new Set(note.tags.map((t) => t.toLowerCase()));
      const missing = add.filter((t) => !lower.has(t.toLowerCase()));
      if (missing.length) changed.push({ ...note, tags: cleanTags([...note.tags, ...missing]), modified: now });
    }
    if (changed.length) await db.notes.bulkUpdate(changed.map((n) => ({ key: n.id, changes: { tags: n.tags, modified: now } })));
    return changed.length;
  });
}

/** Case-insensitive: removing `ad` also removes `AD`, since they read as one tag. */
export async function removeTagsFromNotes(ids: string[], tags: string[], now: Millis = Date.now()): Promise<number> {
  const drop = new Set(cleanTags(tags).map((t) => t.toLowerCase()));
  if (!drop.size || !ids.length) return 0;

  return db.transaction('rw', db.notes, async () => {
    const changed: Note[] = [];
    for (const note of await liveNotes(ids)) {
      const kept = note.tags.filter((t) => !drop.has(t.toLowerCase()));
      if (kept.length !== note.tags.length) changed.push({ ...note, tags: kept, modified: now });
    }
    if (changed.length) await db.notes.bulkUpdate(changed.map((n) => ({ key: n.id, changes: { tags: n.tags, modified: now } })));
    return changed.length;
  });
}

/**
 * Move notes to another deck, with everything that hangs off them.
 *
 * Cards carry a denormalized `deckId` for the due-queue index, and review logs
 * carry one for daily limits, so all three move together — the same rule
 * `moveDeckContents` follows for a whole deck. Retired (soft-deleted) cards
 * move too, so a later restore brings them back into the right deck.
 */
export async function moveNotes(ids: string[], toDeckId: string, now: Millis = Date.now()): Promise<number> {
  if (!ids.length) return 0;

  return db.transaction('rw', [db.decks, db.notes, db.cards, db.reviewLogs], async () => {
    if (!(await db.decks.get(toDeckId))) throw new Error('That deck no longer exists.');

    const moving = (await liveNotes(ids)).filter((n) => n.deckId !== toDeckId);
    if (!moving.length) return 0;
    const noteIds = moving.map((n) => n.id);

    await db.notes.bulkUpdate(moving.map((n) => ({ key: n.id, changes: { deckId: toDeckId, modified: now } })));

    const cardIds = await db.cards.where('noteId').anyOf(noteIds).primaryKeys();
    await db.cards.where('noteId').anyOf(noteIds).modify({ deckId: toDeckId });

    if (cardIds.length) {
      await db.reviewLogs.where('cardId').anyOf(cardIds).modify({ deckId: toDeckId });
    }
    return moving.length;
  });
}

/**
 * Suspend or unsuspend every live card of the given notes. Returns the number
 * of *cards* changed — suspension is a card property, and that's the number
 * that tells you something happened.
 */
export async function setNotesSuspended(ids: string[], suspended: boolean): Promise<number> {
  if (!ids.length) return 0;
  return db.transaction('rw', db.cards, async () => {
    return db.cards
      .where('noteId')
      .anyOf(ids)
      .filter((c) => !c.deletedAt && c.suspended !== suspended)
      .modify({ suspended });
  });
}

/**
 * Soft-delete notes and their cards. Returns the ids actually deleted, which
 * is exactly what `restoreNotes` needs for an undo.
 */
export async function deleteNotes(ids: string[], now: Millis = Date.now()): Promise<string[]> {
  if (!ids.length) return [];
  return db.transaction('rw', db.notes, db.cards, async () => {
    const doomed = (await liveNotes(ids)).map((n) => n.id);
    if (!doomed.length) return [];
    await db.notes.where('id').anyOf(doomed).modify({ deletedAt: now });
    await db.cards
      .where('noteId')
      .anyOf(doomed)
      .filter((c) => !c.deletedAt)
      .modify({ deletedAt: now });
    return doomed;
  });
}

/**
 * Undo for `deleteNotes`. Restoring goes through `restoreNote`, which re-runs
 * reconciliation, so each note gets back exactly the cards its text generates
 * — with their scheduling history, since soft delete never dropped it.
 */
export async function restoreNotes(ids: string[]): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    for (const id of ids) await restoreNote(id);
  });
}
