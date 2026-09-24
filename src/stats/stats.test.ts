import { describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import type { Card } from '../db/types';
import { newCard } from '../repo/cards';
import { DAY, HOUR } from '../lib/time';
import { cardCounts, daysAgo, dueForecast, groupDays, niceScale, retention, reviewHistory, streak } from './stats';

const ROLL = 4;
// 12:00 on 2026-09-23, local time.
const NOW = new Date(2026, 8, 23, 12, 0).getTime();
const on = (daysBack: number, hour = 10) => {
  const d = new Date(2026, 8, 23 - daysBack, hour, 0);
  return d.getTime();
};

const log = (reviewedAt: number, state: State, rating = 3, durationMs = 5000) => ({
  reviewedAt,
  state,
  rating,
  durationMs,
});

describe('reviewHistory', () => {
  it('buckets answers by study day and kind, oldest first', () => {
    const h = reviewHistory(
      [
        log(on(0), State.New),
        log(on(0), State.Learning),
        log(on(0), State.Review),
        log(on(2), State.Relearning),
        log(on(40), State.Review), // outside the window
      ],
      7,
      NOW,
      ROLL,
    );
    expect(h).toHaveLength(7);
    expect(h[6]).toMatchObject({ new: 1, learning: 1, review: 1, ms: 15000 });
    expect(h[4]).toMatchObject({ learning: 1 });
    expect(h.reduce((n, d) => n + d.new + d.learning + d.review, 0)).toBe(4);
  });

  it('puts a 1am answer on the previous study day', () => {
    const h = reviewHistory([log(on(0, 1), State.Review)], 2, NOW, ROLL);
    expect(h[0].review).toBe(1);
    expect(h[1].review).toBe(0);
  });
});

function card(patch: Partial<Card>): Card {
  return { ...newCard('n', 'd', 1, NOW - 100 * DAY), ...patch };
}

describe('dueForecast', () => {
  const review = (due: number, extra: Partial<Card> = {}) =>
    card({ state: State.Review, reps: 3, due, scheduledDays: 5, ...extra });

  it('counts overdue and due-today on day 0, later days in their buckets', () => {
    const f = dueForecast(
      [
        review(NOW - 3 * DAY), // overdue
        review(NOW + 2 * HOUR), // later today
        review(NOW + DAY),
        review(NOW + 3 * DAY),
        review(NOW + 60 * DAY), // past the window
        review(NOW, { suspended: true }),
        card({}), // new — never counted
        review(NOW, { deletedAt: NOW }),
      ],
      7,
      NOW,
      ROLL,
    );
    expect(f.map((d) => d.due)).toEqual([2, 1, 0, 1, 0, 0, 0]);
  });
});

describe('retention', () => {
  it('counts only reviews of graduated cards, Again as a fail', () => {
    const r = retention(
      [
        log(on(1), State.Review, 3),
        log(on(1), State.Review, 2),
        log(on(1), State.Review, 1),
        log(on(1), State.Learning, 1), // learning — ignored
        log(on(1), State.New, 1), // first sighting — ignored
        log(on(50), State.Review, 1), // before the window
      ],
      daysAgo(NOW, ROLL, 29),
    );
    expect(r).toEqual({ total: 3, passed: 2, rate: 2 / 3 });
  });

  it('is null with nothing to measure', () => {
    expect(retention([], 0).rate).toBeNull();
  });
});

describe('streak', () => {
  it('counts consecutive study days ending today', () => {
    expect(streak([log(on(0), State.Review), log(on(1), State.Review), log(on(2), State.Review), log(on(4), State.Review)], NOW, ROLL)).toBe(3);
  });

  it('is not broken just because today has not been studied yet', () => {
    expect(streak([log(on(1), State.Review), log(on(2), State.Review)], NOW, ROLL)).toBe(2);
  });

  it('is zero after a missed day', () => {
    expect(streak([log(on(2), State.Review)], NOW, ROLL)).toBe(0);
  });
});

describe('cardCounts', () => {
  it('splits by state, young vs mature at 21 days, suspended on its own', () => {
    const c = cardCounts([
      card({}),
      card({ state: State.Learning, reps: 1 }),
      card({ state: State.Review, reps: 3, scheduledDays: 20 }),
      card({ state: State.Review, reps: 9, scheduledDays: 21 }),
      card({ state: State.Review, reps: 9, scheduledDays: 90, suspended: true }),
      card({ deletedAt: NOW }),
    ]);
    expect(c).toEqual({ new: 1, learning: 1, young: 1, mature: 1, suspended: 1, total: 5 });
  });
});

describe('niceScale', () => {
  it('rounds the axis up to a clean step', () => {
    expect(niceScale(0)).toEqual({ top: 4, step: 1 });
    expect(niceScale(3)).toEqual({ top: 3, step: 1 });
    expect(niceScale(17)).toEqual({ top: 20, step: 5 });
    expect(niceScale(130)).toEqual({ top: 150, step: 50 });
    expect(niceScale(1234)).toEqual({ top: 1500, step: 500 });
  });
});

describe('groupDays', () => {
  it('sums into buckets that end on the last day, oldest bucket possibly partial', () => {
    const days = Array.from({ length: 10 }, (_, i) => ({ day: i, new: 1, learning: 0, review: i, ms: 10 }));
    const weeks = groupDays(days, 7);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toEqual({ day: 0, new: 3, learning: 0, review: 0 + 1 + 2, ms: 30 });
    expect(weeks[1]).toEqual({ day: 3, new: 7, learning: 0, review: 3 + 4 + 5 + 6 + 7 + 8 + 9, ms: 70 });
  });
});
