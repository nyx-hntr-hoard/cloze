/**
 * FSRS scheduling.
 *
 * The one place that talks to `ts-fsrs`. Everything above this file deals in
 * our own `Card` shape with epoch-millisecond dates; conversion happens here
 * and nowhere else.
 *
 * Two things this module is strict about:
 *
 * **Every answer writes a review log.** The log is what stats are computed
 * from and what FSRS parameter optimization trains on. It cannot be
 * reconstructed after the fact, so it is written in the same transaction as the
 * card update — a card whose state advanced without a log is a permanently
 * missing data point.
 *
 * **Undo restores the exact previous card.** Not a recomputed one. `ts-fsrs`
 * offers `rollback`, but storing the row we already had and putting it back is
 * exact by construction and survives a parameter change mid-session.
 */

import {
  fsrs,
  generatorParameters,
  Rating,
  State,
  type FSRSParameters,
  type Grade,
  type RecordLogItem,
  type StepUnit,
} from 'ts-fsrs';
import { db } from '../db/db';
import type { Card, FsrsParams, Millis, ReviewLog } from '../db/types';
import { newId } from '../lib/id';
import { fromFsrsCard, schedulingFields, toFsrsInput } from '../repo/cards';

export { Rating, State };
export type { Grade };

/** The four answer buttons, in the order they are shown. */
export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

export const GRADE_LABELS: Record<Grade, string> = {
  [Rating.Again]: 'Again',
  [Rating.Hard]: 'Hard',
  [Rating.Good]: 'Good',
  [Rating.Easy]: 'Easy',
};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * A learning step is `<number><m|h|d>`. Stored settings are plain strings, so
 * anything malformed is dropped rather than handed to the scheduler, where it
 * would throw mid-session.
 */
const STEP = /^\d+(\.\d+)?[mhd]$/;

function toSteps(values: string[], fallback: string[]): StepUnit[] {
  const clean = values.filter((s) => STEP.test(s.trim())).map((s) => s.trim() as StepUnit);
  return clean.length ? clean : (fallback as StepUnit[]);
}

export function toFsrsParameters(p: FsrsParams): FSRSParameters {
  return generatorParameters({
    request_retention: p.requestRetention,
    maximum_interval: p.maximumInterval,
    enable_fuzz: p.enableFuzz,
    enable_short_term: p.enableShortTerm,
    learning_steps: toSteps(p.learningSteps, ['1m', '10m']),
    relearning_steps: toSteps(p.relearningSteps, ['10m']),
    // An empty weight vector means "use the library defaults"; passing `[]`
    // through would be rejected.
    ...(p.w.length ? { w: p.w } : {}),
  });
}

export type Scheduler = ReturnType<typeof fsrs>;

export function makeScheduler(params: FsrsParams): Scheduler {
  return fsrs(toFsrsParameters(params));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface GradePreview {
  grade: Grade;
  label: string;
  /** When the card would next come up. */
  due: Millis;
  /** Time from now until then, for the button label. */
  intervalMs: number;
}

/**
 * What each of the four buttons would do, so the UI can show real intervals
 * before the answer is given rather than after.
 */
export function previewGrades(
  scheduler: Scheduler,
  card: Card,
  now: Millis = Date.now(),
): GradePreview[] {
  const preview = scheduler.repeat(toFsrsInput(card), now);
  return GRADES.map((grade) => {
    const item: RecordLogItem = preview[grade];
    const due = item.card.due.getTime();
    return {
      grade,
      label: GRADE_LABELS[grade],
      due,
      intervalMs: Math.max(0, due - now),
    };
  });
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export interface AnswerResult {
  /** The card as it now stands. */
  card: Card;
  /** The card as it stood before — everything undo needs. */
  previous: Card;
  logId: string;
  intervalMs: number;
}

/**
 * Apply a grade to a card: advance its scheduling state and append a review
 * log, atomically.
 */
export async function answerCard(
  scheduler: Scheduler,
  card: Card,
  grade: Grade,
  now: Millis = Date.now(),
  durationMs?: number,
): Promise<AnswerResult> {
  const { card: scheduled, log } = scheduler.next(toFsrsInput(card), now, grade);
  const next = fromFsrsCard(card, scheduled);

  const entry: ReviewLog = {
    id: newId(),
    cardId: card.id,
    deckId: card.deckId,
    rating: log.rating,
    // The state the card was in *before* this answer, which is what an
    // optimizer needs and what "new cards studied today" counts.
    state: log.state,
    due: log.due.getTime(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    learningSteps: log.learning_steps,
    reviewedAt: log.review.getTime(),
    ...(durationMs === undefined ? {} : { durationMs }),
  };

  await db.transaction('rw', db.cards, db.reviewLogs, async () => {
    await db.cards.update(next.id, schedulingFields(next));
    await db.reviewLogs.add(entry);
  });

  return {
    card: next,
    previous: card,
    logId: entry.id,
    intervalMs: Math.max(0, next.due - now),
  };
}

/**
 * Undo one answer: restore the card's previous schedule and drop its review log.
 *
 * Deleting the log is deliberate. A logged review that the user took back is
 * not a data point about their memory — keeping it would poison both the stats
 * and any future parameter training.
 */
export async function undoAnswer(result: AnswerResult): Promise<void> {
  await db.transaction('rw', db.cards, db.reviewLogs, async () => {
    await db.cards.update(result.previous.id, schedulingFields(result.previous));
    await db.reviewLogs.delete(result.logId);
  });
}

// ---------------------------------------------------------------------------
// Retrievability
// ---------------------------------------------------------------------------

/** Estimated recall probability right now, 0–1. Shown on the card info panel. */
export function retrievability(scheduler: Scheduler, card: Card, now: Millis = Date.now()): number {
  if (card.reps === 0) return 0;
  return scheduler.get_retrievability(toFsrsInput(card), now, false);
}
