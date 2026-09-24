/**
 * Deck repository.
 *
 * Everything that touches Dexie lives under `src/repo`. Components import
 * these functions, never `db` directly — so swapping the persistence layer
 * (File System Access API, a sync backend) later is a change in one directory.
 */

import { db } from '../db/db';
import { DEFAULT_DECK_CONFIG, type Deck, type DeckConfig } from '../db/types';
import { newId } from '../lib/id';

export interface DeckStats {
  deckId: string;
  /** Live (non-deleted, non-suspended) card count. */
  total: number;
  /** Cards never studied. */
  newCount: number;
  /** Cards due at or before `now`. */
  dueCount: number;
  suspended: number;
}

export async function listDecks(): Promise<Deck[]> {
  const decks = await db.decks.toArray();
  return decks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function getDeck(id: string): Promise<Deck | undefined> {
  return db.decks.get(id);
}

export async function createDeck(input: {
  name: string;
  description?: string;
  config?: Partial<DeckConfig>;
}): Promise<Deck> {
  const name = input.name.trim();
  if (!name) throw new Error('Deck name cannot be empty.');

  const now = Date.now();
  const deck: Deck = {
    id: newId(),
    name,
    description: input.description?.trim() ?? '',
    config: { ...DEFAULT_DECK_CONFIG, ...input.config },
    created: now,
    modified: now,
  };
  await db.decks.add(deck);
  return deck;
}

export async function updateDeck(
  id: string,
  patch: Partial<Pick<Deck, 'name' | 'description' | 'config'>>,
): Promise<void> {
  const next: Partial<Deck> = { ...patch, modified: Date.now() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('Deck name cannot be empty.');
    next.name = name;
  }
  if (patch.description !== undefined) next.description = patch.description.trim();
  await db.decks.update(id, next);
}

/**
 * Delete a deck and everything under it.
 *
 * This is the one genuinely destructive operation in the app, so it is a hard
 * delete inside a single transaction: a half-deleted deck leaves orphan cards
 * that show up in the queue with no deck to name them. The UI is responsible
 * for confirming, and for offering an export first.
 *
 * Media is *not* deleted here — a blob may be referenced by notes in other
 * decks. Orphans are collected by the "check media" tool in a later phase.
 */
export async function deleteDeck(id: string): Promise<void> {
  await db.transaction('rw', db.decks, db.notes, db.cards, db.reviewLogs, async () => {
    await db.reviewLogs.where('deckId').equals(id).delete();
    await db.cards.where('deckId').equals(id).delete();
    await db.notes.where('deckId').equals(id).delete();
    await db.decks.delete(id);
  });
}

/** Move every note and card from one deck to another. */
export async function moveDeckContents(fromId: string, toId: string): Promise<number> {
  return db.transaction('rw', db.notes, db.cards, db.reviewLogs, async () => {
    const moved = await db.notes.where('deckId').equals(fromId).modify({ deckId: toId });
    await db.cards.where('deckId').equals(fromId).modify({ deckId: toId });
    await db.reviewLogs.where('deckId').equals(fromId).modify({ deckId: toId });
    return moved;
  });
}

/**
 * Counts for the deck list. One pass over each deck's cards rather than four
 * separate count queries.
 */
export async function deckStats(deckId: string, now = Date.now()): Promise<DeckStats> {
  const stats: DeckStats = { deckId, total: 0, newCount: 0, dueCount: 0, suspended: 0 };

  await db.cards
    .where('deckId')
    .equals(deckId)
    .each((card) => {
      if (card.deletedAt) return;
      stats.total++;
      if (card.suspended) {
        stats.suspended++;
        return;
      }
      if (card.reps === 0) stats.newCount++;
      else if (card.due <= now) stats.dueCount++;
    });

  return stats;
}

export async function allDeckStats(now = Date.now()): Promise<Map<string, DeckStats>> {
  const byDeck = new Map<string, DeckStats>();
  const decks = await db.decks.toArray();
  for (const d of decks) {
    byDeck.set(d.id, { deckId: d.id, total: 0, newCount: 0, dueCount: 0, suspended: 0 });
  }

  await db.cards.each((card) => {
    if (card.deletedAt) return;
    const s = byDeck.get(card.deckId);
    if (!s) return;
    s.total++;
    if (card.suspended) {
      s.suspended++;
      return;
    }
    if (card.reps === 0) s.newCount++;
    else if (card.due <= now) s.dueCount++;
  });

  return byDeck;
}
