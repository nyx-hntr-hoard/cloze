/**
 * A synthetic reviewer, for testing the optimizer against a known truth.
 *
 * Cards are studied by a simulated person whose memory follows FSRS with a
 * *chosen* weight set; recall on each review is a coin flip weighted by the
 * true retrievability. An optimizer that works should move from the default
 * weights toward that truth — measurably, on cards it wasn't trained on.
 *
 * Deterministic (seeded), so a failing test fails the same way every run.
 * Not imported by the app, so it never reaches the bundle.
 */

import { Rating, State } from 'ts-fsrs';
import type { ReviewLog } from '../db/types';
import { DAY, HOUR } from '../lib/time';
import { curveOf, initState, nextState, recall, type MemoryState } from './model';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulationOptions {
  cards: number;
  days: number;
  seed?: number;
  /** Midnight-ish local timestamp for day 0. Reviews land at 10:00 local. */
  start: number;
  shortTerm?: boolean;
}

type SimLog = Pick<ReviewLog, 'cardId' | 'rating' | 'state' | 'reviewedAt'>;

export function simulate(trueW: readonly number[], opts: SimulationOptions): SimLog[] {
  const rand = mulberry32(opts.seed ?? 1);
  const curve = curveOf(trueW);
  const shortTerm = opts.shortTerm ?? true;
  const logs: SimLog[] = [];

  for (let c = 0; c < opts.cards; c++) {
    const cardId = `sim-${c}`;
    let day = Math.floor(rand() * opts.days * 0.6);
    let state: MemoryState | null = null;
    let lastDay = day;
    let cardState = State.New;

    while (day < opts.days) {
      let rating: number;
      if (!state) {
        const u = rand();
        rating = u < 0.2 ? Rating.Again : u < 0.3 ? Rating.Hard : u < 0.9 ? Rating.Good : Rating.Easy;
        state = initState(trueW, rating);
      } else {
        const t = day - lastDay;
        const remembered = rand() < recall(curve, t, state.stability);
        const u = rand();
        rating = !remembered ? Rating.Again : u < 0.15 ? Rating.Hard : u < 0.9 ? Rating.Good : Rating.Easy;
        state = nextState(trueW, curve, shortTerm, state, t, rating);
      }

      logs.push({ cardId, rating, state: cardState, reviewedAt: opts.start + day * DAY + 10 * HOUR });
      cardState = rating === Rating.Again ? State.Relearning : State.Review;
      lastDay = day;
      // Schedule at ~90% retention, which is where the interval equals stability,
      // with some jitter so the history isn't unnaturally regular.
      const interval = rating === Rating.Again ? 1 : Math.max(1, Math.round(state.stability * (0.85 + rand() * 0.3)));
      day += interval;
    }
  }

  return logs;
}
