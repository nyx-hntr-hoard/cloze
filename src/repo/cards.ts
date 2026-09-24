/**
 * Card repository, including the note→card reconciliation that runs whenever a
 * note's text changes.
 */

import { createEmptyCard, State, type Card as FsrsCard, type CardInput } from 'ts-fsrs';
import { db } from '../db/db';
import type { Card, Millis } from '../db/types';
import { newId } from '../lib/id';

// ---------------------------------------------------------------------------
// Conversion to/from the ts-fsrs card shape
// ---------------------------------------------------------------------------

/**
 * Our stored card as a ts-fsrs `CardInput`. `CardInput` accepts `DateInput`
 * (number is a `DateInput`), so epoch millis pass straight through and no
 * `Date` ever needs to be constructed on the read path.
 */
export function toFsrsInput(card: Card): CardInput {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsedDays,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview ?? null,
  };
}

/**
 * Just the fields an answer changes. Written as a partial update rather than
 * a whole-row put, so that with sync on, a concurrent change to anything else
 * on the card from another device (suspending it, moving its deck) survives.
 * `lastReview: undefined` deletes the property, which is what undo needs.
 */
export function schedulingFields(card: Card): Partial<Card> {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.lastReview,
  };
}

/** Fold a ts-fsrs scheduling result back into our stored shape. */
export function fromFsrsCard(card: Card, next: FsrsCard): Card {
  return {
    ...card,
    due: next.due.getTime(),
    stability: next.stability,
    difficulty: next.difficulty,
    elapsedDays: next.elapsed_days,
    scheduledDays: next.scheduled_days,
    learningSteps: next.learning_steps,
    reps: next.reps,
    lapses: next.lapses,
    state: next.state,
    lastReview: next.last_review ? next.last_review.getTime() : undefined,
  };
}

/** A brand-new, never-studied card for a given note ordinal. */
export function newCard(noteId: string, deckId: string, ordinal: number, now: Millis = Date.now()): Card {
  const empty = createEmptyCard(now);
  return {
    id: newId(),
    noteId,
    deckId,
    ordinal,
    due: empty.due.getTime(),
    stability: empty.stability,
    difficulty: empty.difficulty,
    elapsedDays: empty.elapsed_days,
    scheduledDays: empty.scheduled_days,
    learningSteps: empty.learning_steps,
    reps: empty.reps,
    lapses: empty.lapses,
    state: empty.state ?? State.New,
    suspended: false,
    created: now,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getCard(id: string): Promise<Card | undefined> {
  return db.cards.get(id);
}

/** All live cards for a note, in ordinal order. */
export async function cardsForNote(noteId: string, includeDeleted = false): Promise<Card[]> {
  const rows = await db.cards.where('noteId').equals(noteId).toArray();
  const live = includeDeleted ? rows : rows.filter((c) => !c.deletedAt);
  return live.sort((a, b) => a.ordinal - b.ordinal);
}

export async function setSuspended(cardIds: string[], suspended: boolean): Promise<void> {
  await db.cards.where('id').anyOf(cardIds).modify({ suspended });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  created: Card[];
  /** Cards whose ordinal disappeared from the note; soft-deleted, not dropped. */
  removed: Card[];
  /** Cards that were soft-deleted and came back (ordinal re-added). */
  restored: Card[];
  unchanged: Card[];
}

/**
 * Bring a note's cards in line with the ordinals its text now contains.
 *
 * This is the function that protects review history. Three rules:
 *
 *  1. A *new* ordinal creates a fresh card.
 *  2. A *missing* ordinal soft-deletes its card. Never a hard delete — a
 *     mistyped edit that momentarily drops `{{c2::...}}` must not destroy
 *     months of scheduling state, and undoing the edit must bring it back.
 *  3. A *returning* ordinal restores the soft-deleted card, scheduling state
 *     intact, rather than creating a second one.
 *
 * Renumbering (c2 → c1) therefore lands as "c1 already exists, c2 removed" —
 * the surviving card keeps its history. That is the correct conservative
 * behaviour: the alternative, trying to guess that a renumber is a rename,
 * silently reassigns history to the wrong prompt.
 *
 * Pure with respect to parsing: callers supply the ordinal set, so the cloze
 * parser (phase 2) and this logic are testable independently.
 */
export async function reconcileCards(
  noteId: string,
  deckId: string,
  ordinals: number[],
  now: Millis = Date.now(),
): Promise<ReconcileResult> {
  const wanted = new Set(ordinals.filter((n) => Number.isInteger(n) && n > 0));

  return db.transaction('rw', db.cards, async () => {
    const existing = await db.cards.where('noteId').equals(noteId).toArray();
    const byOrdinal = new Map<number, Card>();
    for (const card of existing) {
      // If duplicates somehow exist for an ordinal, prefer the live one.
      const prev = byOrdinal.get(card.ordinal);
      if (!prev || (prev.deletedAt && !card.deletedAt)) byOrdinal.set(card.ordinal, card);
    }

    const result: ReconcileResult = { created: [], removed: [], restored: [], unchanged: [] };
    /** Live cards that only needed their denormalized deckId corrected. */
    const moved: Card[] = [];

    for (const ordinal of wanted) {
      const current = byOrdinal.get(ordinal);
      if (!current) {
        result.created.push(newCard(noteId, deckId, ordinal, now));
      } else if (current.deletedAt) {
        const restored = { ...current, deckId };
        delete restored.deletedAt;
        result.restored.push(restored);
      } else if (current.deckId !== deckId) {
        const relocated = { ...current, deckId };
        moved.push(relocated);
        result.unchanged.push(relocated);
      } else {
        result.unchanged.push(current);
      }
    }

    for (const card of byOrdinal.values()) {
      if (!wanted.has(card.ordinal) && !card.deletedAt) {
        result.removed.push({ ...card, deletedAt: now });
      }
    }

    // New cards are whole rows; everything else is a field-level update, so a
    // synced edit elsewhere to the same card (its schedule, say) isn't
    // overwritten by a stale copy of the whole row.
    if (result.created.length) await db.cards.bulkAdd(result.created);
    const updates = [
      ...result.restored.map((c) => ({ key: c.id, changes: { deckId: c.deckId, deletedAt: undefined } })),
      ...result.removed.map((c) => ({ key: c.id, changes: { deletedAt: c.deletedAt } })),
      ...moved.map((c) => ({ key: c.id, changes: { deckId: c.deckId } })),
    ];
    if (updates.length) await db.cards.bulkUpdate(updates);

    return result;
  });
}

/**
 * Permanently drop cards that have been soft-deleted for longer than
 * `olderThanMs`. Not wired to any UI yet — exposed so the maintenance screen in
 * a later phase has something to call, and so backups can be pruned.
 */
export async function purgeDeletedCards(olderThanMs: number, now: Millis = Date.now()): Promise<number> {
  const cutoff = now - olderThanMs;
  const doomed = await db.cards.filter((c) => c.deletedAt !== undefined && c.deletedAt < cutoff).toArray();
  if (!doomed.length) return 0;
  const ids = doomed.map((c) => c.id);
  await db.transaction('rw', db.cards, db.reviewLogs, async () => {
    await db.reviewLogs.where('cardId').anyOf(ids).delete();
    await db.cards.bulkDelete(ids);
  });
  return ids.length;
}
