/**
 * Statistics, computed from cards and review logs.
 *
 * Pure functions; the route loads the rows. Every "per day" figure here is a
 * *study* day, bucketed with the rollover hour, so a late-night session counts
 * toward the day you think it does — the same rule the queue and the optimizer
 * use, so the numbers on this screen agree with the numbers everywhere else.
 */

import { State } from 'ts-fsrs';
import type { Card, Millis, ReviewLog } from '../db/types';
import { dayEnd, dayStart, DAY } from '../lib/time';
import { kindOf } from '../review/queue';

type Log = Pick<ReviewLog, 'reviewedAt' | 'rating' | 'state' | 'durationMs'>;

/** Anki's line between a young and a mature card: an interval of 21 days. */
export const MATURE_DAYS = 21;

/** Study-day start for `n` days before (negative) or after the current one. */
function dayOffset(now: Millis, rollover: number, n: number): Millis {
  const d = new Date(dayStart(now, rollover));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * Maps a timestamp to its day bucket (0 = `first`), or -1 outside the range.
 * Boundaries come from calendar arithmetic, not `+ 24h`, so a DST change
 * doesn't shift every later bucket by an hour.
 */
function bucketer(first: Millis, count: number) {
  const starts: Millis[] = [];
  for (let i = 0; i <= count; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    starts.push(d.getTime());
  }
  return (at: Millis): number => {
    if (at < starts[0] || at >= starts[count]) return -1;
    let i = Math.min(count - 1, Math.floor((at - starts[0]) / DAY));
    while (i > 0 && at < starts[i]) i--;
    while (i < count - 1 && at >= starts[i + 1]) i++;
    return i;
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface DayActivity {
  /** Start of the study day. */
  day: Millis;
  /** First-ever reviews. */
  new: number;
  /** Learning and relearning steps. */
  learning: number;
  /** Reviews of graduated cards. */
  review: number;
  /** Time spent answering, where it was recorded. */
  ms: number;
}

/** What kind of answer a log was, by the card's state *before* answering. */
export function logKind(state: State): 'new' | 'learning' | 'review' {
  if (state === State.New) return 'new';
  if (state === State.Learning || state === State.Relearning) return 'learning';
  return 'review';
}

/** The last `days` study days, oldest first, ending with today. */
export function reviewHistory(logs: Log[], days: number, now: Millis, rollover: number): DayActivity[] {
  const first = dayOffset(now, rollover, -(days - 1));
  const out: DayActivity[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    out.push({ day: d.getTime(), new: 0, learning: 0, review: 0, ms: 0 });
  }
  const bucket = bucketer(first, days);
  for (const log of logs) {
    const i = bucket(log.reviewedAt);
    if (i < 0) continue;
    out[i][logKind(log.state)]++;
    out[i].ms += log.durationMs ?? 0;
  }
  return out;
}

/**
 * Roll daily activity up into `size`-day buckets, aligned to end on the last
 * day — so "this week" is always the final bucket. A year of daily columns is
 * 365 slivers under a pixel wide; 53 weekly ones can actually be read.
 */
export function groupDays(days: DayActivity[], size: number): DayActivity[] {
  const out: DayActivity[] = [];
  for (let end = days.length; end > 0; end -= size) {
    const chunk = days.slice(Math.max(0, end - size), end);
    out.unshift(
      chunk.reduce(
        (acc, d) => ({
          day: acc.day,
          new: acc.new + d.new,
          learning: acc.learning + d.learning,
          review: acc.review + d.review,
          ms: acc.ms + d.ms,
        }),
        { day: chunk[0].day, new: 0, learning: 0, review: 0, ms: 0 },
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

export interface DayDue {
  day: Millis;
  /** Cards due that day. Day 0 includes everything already overdue. */
  due: number;
}

/**
 * Scheduled reviews over the next `days` study days. Counts learning and
 * review cards that aren't suspended — new cards aren't "due", they're
 * introduced by the daily new-card limit.
 */
export function dueForecast(cards: Card[], days: number, now: Millis, rollover: number): DayDue[] {
  const first = dayOffset(now, rollover, 0);
  const out: DayDue[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    out.push({ day: d.getTime(), due: 0 });
  }
  const bucket = bucketer(first, days);
  const todayEnd = dayEnd(now, rollover);
  for (const card of cards) {
    if (card.deletedAt || card.suspended || kindOf(card) === 'new') continue;
    if (card.due < todayEnd) {
      out[0].due++;
      continue;
    }
    const i = bucket(card.due);
    if (i >= 0) out[i].due++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary figures
// ---------------------------------------------------------------------------

export interface Retention {
  /** Reviews of graduated cards in the window. */
  total: number;
  /** Of those, answered Hard, Good or Easy. */
  passed: number;
  /** `passed / total`, or null with nothing to measure. */
  rate: number | null;
}

/**
 * "True retention": how often a *review* card (not a new or learning one) was
 * remembered. It's the figure to compare with desired retention — learning
 * steps and first sightings would muddy it.
 */
export function retention(logs: Log[], since: Millis): Retention {
  let total = 0;
  let passed = 0;
  for (const log of logs) {
    if (log.reviewedAt < since || log.state !== State.Review) continue;
    total++;
    if (log.rating > 1) passed++;
  }
  return { total, passed, rate: total ? passed / total : null };
}

/**
 * Consecutive study days with at least one review, ending today — or ending
 * yesterday if today hasn't been studied yet, so a streak doesn't read as
 * broken at breakfast.
 */
export function streak(logs: Log[], now: Millis, rollover: number): number {
  const days = new Set<number>();
  for (const log of logs) days.add(dayStart(log.reviewedAt, rollover));

  let cursor = dayStart(now, rollover);
  if (!days.has(cursor)) cursor = dayOffset(now, rollover, -1);
  let n = 0;
  while (days.has(cursor)) {
    n++;
    const d = new Date(cursor);
    d.setDate(d.getDate() - 1);
    cursor = d.getTime();
  }
  return n;
}

export interface CardCounts {
  new: number;
  learning: number;
  /** Review cards with an interval under 21 days. */
  young: number;
  /** Review cards with an interval of 21 days or more. */
  mature: number;
  /** Suspended cards, whatever their state — not counted in the others. */
  suspended: number;
  total: number;
}

export function cardCounts(cards: Card[]): CardCounts {
  const out: CardCounts = { new: 0, learning: 0, young: 0, mature: 0, suspended: 0, total: 0 };
  for (const card of cards) {
    if (card.deletedAt) continue;
    out.total++;
    if (card.suspended) {
      out.suspended++;
      continue;
    }
    const kind = kindOf(card);
    if (kind === 'review') {
      if (card.scheduledDays >= MATURE_DAYS) out.mature++;
      else out.young++;
    } else out[kind]++;
  }
  return out;
}

/** Start of the study day `n` days back from today — for "last 30 days" windows. */
export function daysAgo(now: Millis, rollover: number, n: number): Millis {
  return dayOffset(now, rollover, -n);
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/** A round axis maximum with 3–5 ticks: 1, 2 or 5 × 10ⁿ steps. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough)!;
  const intStep = Math.max(1, Math.round(step)); // counts are whole numbers
  return { top: Math.ceil(max / intStep) * intStep, step: intStep };
}
