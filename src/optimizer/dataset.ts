/**
 * Turning review logs into training sequences.
 *
 * FSRS learns from each card's history as a sequence of (days since the last
 * review, rating) pairs, starting from the card's first-ever review. Two
 * rules decide what counts:
 *
 *  - **A history must start at the beginning.** The first log has to be the
 *    card's first review (logged state `New`). A card imported with scheduling
 *    state but no history, or whose early logs were lost, can't be replayed —
 *    the model would be starting from a memory state it never saw — so it is
 *    skipped, not guessed at.
 *  - **Days are study days**, counted with the same rollover hour the review
 *    screen uses. A review at 1am and one at 11pm the evening before are the
 *    same day, exactly as the scheduler saw them.
 *
 * If a card goes back to `New` later (a reset), its history after that is a
 * fresh sequence; what came before no longer describes the memory.
 */

import { State } from 'ts-fsrs';
import type { ReviewLog } from '../db/types';
import { studyDayNumber } from '../lib/time';

export interface Sequence {
  cardId: string;
  /** Whole study days since the previous review; `deltas[0]` is always 0. */
  deltas: number[];
  /** 1 Again · 2 Hard · 3 Good · 4 Easy. */
  ratings: number[];
}

export interface Dataset {
  sequences: Sequence[];
  /** Reviews the model can be scored on: not a card's first, not same-day. */
  predictions: number;
  /** Cards left out because their history doesn't start at the first review. */
  skippedCards: number;
}

type LogLike = Pick<ReviewLog, 'cardId' | 'rating' | 'state' | 'reviewedAt'>;

export function buildDataset(logs: LogLike[], rolloverHour: number): Dataset {
  const byCard = new Map<string, LogLike[]>();
  for (const log of logs) {
    if (!Number.isInteger(log.rating) || log.rating < 1 || log.rating > 4) continue;
    const list = byCard.get(log.cardId);
    if (list) list.push(log);
    else byCard.set(log.cardId, [log]);
  }

  const sequences: Sequence[] = [];
  let predictions = 0;
  let skippedCards = 0;

  for (const [cardId, list] of byCard) {
    list.sort((a, b) => a.reviewedAt - b.reviewedAt);
    if (list[0].state !== State.New) {
      skippedCards++;
      continue;
    }

    let current: Sequence | null = null;
    let prevDay = 0;
    for (const log of list) {
      const day = studyDayNumber(log.reviewedAt, rolloverHour);
      if (log.state === State.New || !current) {
        current = { cardId, deltas: [0], ratings: [log.rating] };
        sequences.push(current);
      } else {
        const delta = Math.max(0, day - prevDay);
        current.deltas.push(delta);
        current.ratings.push(log.rating);
        if (delta > 0) predictions++;
      }
      prevDay = day;
    }
  }

  return { sequences, predictions, skippedCards };
}
