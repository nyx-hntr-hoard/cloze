/**
 * Queue building.
 *
 * Decides what to study next, and how much. Three ideas do most of the work:
 *
 * **The study day is not the calendar day.** It starts at the deck's rollover
 * hour (4am by default), so a session at 1am counts toward the previous day.
 * Otherwise a late night silently spends tomorrow's new-card budget, and your
 * streak breaks while you are still studying.
 *
 * **Daily limits are counted from the review log, not from a counter.** A
 * counter drifts — it has to be reset by something, and that something is a bug
 * waiting to happen across tabs, reloads and clock changes. Counting the logs
 * in the current study-day window is always right, and the compound
 * `[deckId+reviewedAt]` index makes it a range read.
 *
 * **Learning cards are not subject to the review limit.** Once a card is in
 * learning you have already spent the budget on it; refusing to finish its
 * steps would leave it stranded mid-way overnight.
 */

import { State } from 'ts-fsrs';
import { db } from '../db/db';
import type { Card, Deck, Millis } from '../db/types';
import { dayEnd, dayStart } from '../lib/time';

export type QueueKind = 'learning' | 'review' | 'new';

export interface QueueCounts {
  learning: number;
  review: number;
  new: number;
}

export interface BuiltQueue {
  /** Cards to study, in order. */
  cards: Card[];
  /** Remaining counts by kind, for the progress display. */
  counts: QueueCounts;
  /** True when more cards are due but the daily limit stopped them. */
  cappedNew: boolean;
  cappedReview: boolean;
  /**
   * When the queue is empty only because learning cards are still ticking,
   * this is when the next one comes up. `undefined` means genuinely done.
   */
  nextLearningAt?: Millis;
}

export interface DayProgress {
  /** Cards seen for the first time in this study day. */
  newStudied: number;
  /** Non-learning reviews answered in this study day. */
  reviewsDone: number;
  /** Every answer in the window, including learning steps. */
  totalAnswers: number;
}

/** Which bucket a card belongs to right now. */
export function kindOf(card: Card): QueueKind {
  if (card.state === State.New || card.reps === 0) return 'new';
  if (card.state === State.Learning || card.state === State.Relearning) return 'learning';
  return 'review';
}

/** The rollover hour a deck uses, falling back to the global setting. */
export function rolloverFor(deck: Deck | undefined, globalHour: number): number {
  const hour = deck?.config.rolloverHour;
  return Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : globalHour;
}

/**
 * What has already been answered in this deck today.
 *
 * `state` on a review log is the state the card was in *before* the answer, so
 * a log with `state === New` is exactly "a card introduced today", which is
 * what the new-card limit means.
 */
export async function dayProgress(
  deckId: string,
  rolloverHour: number,
  now: Millis = Date.now(),
): Promise<DayProgress> {
  const from = dayStart(now, rolloverHour);
  const to = dayEnd(now, rolloverHour);

  const progress: DayProgress = { newStudied: 0, reviewsDone: 0, totalAnswers: 0 };

  await db.reviewLogs
    .where('[deckId+reviewedAt]')
    .between([deckId, from], [deckId, to], true, false)
    .each((log) => {
      progress.totalAnswers++;
      if (log.state === State.New) progress.newStudied++;
      else if (log.state === State.Review) progress.reviewsDone++;
    });

  return progress;
}

/**
 * Build the study queue for a deck.
 *
 * Ordering is learning, then review, then new. Reviews come before new cards so
 * that a backlog is worked down before more material is added — the failure
 * mode of the reverse is a queue that grows faster than you can clear it.
 * Within each bucket, the card waiting longest goes first.
 */
export async function buildQueue(
  deck: Deck,
  globalRolloverHour: number,
  now: Millis = Date.now(),
): Promise<BuiltQueue> {
  const rolloverHour = rolloverFor(deck, globalRolloverHour);
  const progress = await dayProgress(deck.id, rolloverHour, now);

  const learning: Card[] = [];
  /** Learning cards not due yet but close enough to study ahead. */
  const soon: Card[] = [];
  const review: Card[] = [];
  const fresh: Card[] = [];
  let nextLearningAt: Millis | undefined;

  await db.cards
    .where('deckId')
    .equals(deck.id)
    .each((card) => {
      if (card.deletedAt || card.suspended) return;

      const kind = kindOf(card);
      if (kind === 'new') {
        fresh.push(card);
        return;
      }
      if (card.due > now) {
        // Not due yet. A learning card due in a few minutes is worth waiting
        // for; a review card due in three days is not.
        if (kind === 'learning') {
          if (nextLearningAt === undefined || card.due < nextLearningAt) nextLearningAt = card.due;
          if (card.due - now <= LEARNING_HORIZON) soon.push(card);
        }
        return;
      }
      (kind === 'learning' ? learning : review).push(card);
    });

  learning.sort((a, b) => a.due - b.due);
  soon.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due);
  fresh.sort((a, b) => a.created - b.created || a.ordinal - b.ordinal);

  // --- limits ---------------------------------------------------------
  const newAllowance = deck.config.newPerDay === 0 ? 0 : deck.config.newPerDay - progress.newStudied;
  const allowedNew = fresh.slice(0, Math.max(0, newAllowance));

  const reviewAllowance =
    deck.config.reviewsPerDay === 0
      ? Number.POSITIVE_INFINITY
      : deck.config.reviewsPerDay - progress.reviewsDone;
  const allowedReview = review.slice(0, Math.max(0, reviewAllowance));

  // --- learn ahead ----------------------------------------------------
  // With nothing else to study, a learning card due in a minute is shown now
  // rather than making you sit and wait for it — Anki's learn-ahead limit. Only
  // when the queue is otherwise empty, so a not-yet-due step never jumps ahead
  // of work that is actually due. `reinsert` uses the same horizon, so a card
  // behaves identically whether it stayed in the session queue or arrived on a
  // rebuild.
  const otherwiseEmpty =
    learning.length === 0 && allowedReview.length === 0 && allowedNew.length === 0;
  const aheadOf = otherwiseEmpty ? soon : [];

  const cards = [...learning, ...aheadOf, ...allowedReview, ...allowedNew];

  return {
    cards,
    counts: {
      learning: learning.length + aheadOf.length,
      review: allowedReview.length,
      new: allowedNew.length,
    },
    cappedNew: allowedNew.length < fresh.length,
    cappedReview: allowedReview.length < review.length,
    // Only meaningful when there is genuinely nothing to hand over.
    ...(cards.length === 0 && nextLearningAt !== undefined ? { nextLearningAt } : {}),
  };
}

/**
 * Counts for the deck list, respecting the same daily limits the queue uses.
 * Showing "40 due" and then handing over 20 because of a limit is the kind of
 * small dishonesty that makes an app feel broken.
 */
export async function queueCounts(
  deck: Deck,
  globalRolloverHour: number,
  now: Millis = Date.now(),
): Promise<QueueCounts> {
  const { counts } = await buildQueue(deck, globalRolloverHour, now);
  return counts;
}

export function totalOf(counts: QueueCounts): number {
  return counts.learning + counts.review + counts.new;
}

/** Queue-aware counts for every deck, keyed by deck id. */
export async function allQueueCounts(
  decks: Deck[],
  globalRolloverHour: number,
  now: Millis = Date.now(),
): Promise<Map<string, QueueCounts>> {
  const entries = await Promise.all(
    decks.map(async (deck) => [deck.id, await queueCounts(deck, globalRolloverHour, now)] as const),
  );
  return new Map(entries);
}

/**
 * How long a learning card may be away and still stay in the session queue.
 * Beyond this it drops out and comes back on a later queue build, which is what
 * stops a 1-day relearning step from pinning a session open.
 */
export const LEARNING_HORIZON_MINUTES = 20;
export const LEARNING_HORIZON = LEARNING_HORIZON_MINUTES * 60_000;

/**
 * Put a card back into an in-session queue after it was answered.
 *
 * Learning cards due again shortly rejoin in due order; everything else leaves
 * the session. Doing this locally rather than rebuilding from the database on
 * every answer keeps answering O(1) instead of O(deck).
 */
export function reinsert(queue: Card[], card: Card, now: Millis = Date.now()): Card[] {
  const kind = kindOf(card);
  if (kind !== 'learning' || card.due - now > LEARNING_HORIZON) return queue;

  const at = queue.findIndex((c) => kindOf(c) !== 'learning' || c.due > card.due);
  const next = [...queue];
  next.splice(at === -1 ? next.length : at, 0, card);
  return next;
}
