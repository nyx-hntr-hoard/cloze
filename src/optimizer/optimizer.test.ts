import { describe, expect, it } from 'vitest';
import { FSRSAlgorithm, State, default_w, generatorParameters } from 'ts-fsrs';
import { DAY, HOUR } from '../lib/time';
import { buildDataset } from './dataset';
import { curveOf, initState, nextState, recall } from './model';
import { simulate } from './simulate';
import {
  MIN_PREDICTIONS,
  OptimizationCancelled,
  capTraining,
  clip,
  effectiveWeights,
  evaluate,
  optimize,
  replay,
  splitByCard,
  trainAndCompare,
  type ModelConfig,
} from './train';

const CFG: ModelConfig = { shortTerm: true, relearningSteps: 1 };
const START = new Date(2026, 0, 1, 0, 0).getTime();

function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------------------
// The model must be ts-fsrs, exactly
// ---------------------------------------------------------------------------

describe('model parity with ts-fsrs', () => {
  for (const shortTerm of [true, false]) {
    it(`matches FSRSAlgorithm.next_state over random histories (short-term ${shortTerm ? 'on' : 'off'})`, () => {
      const rand = lcg(shortTerm ? 7 : 11);
      // Default weights plus a handful of random legal weight sets.
      const weightSets = [clip([...default_w], { shortTerm, relearningSteps: 1 })];
      for (let k = 0; k < 5; k++) {
        const w = default_w.map((v) => v * (0.5 + rand()));
        weightSets.push(clip(w, { shortTerm, relearningSteps: 1 }));
      }

      let compared = 0;
      for (const w of weightSets) {
        const ref = new FSRSAlgorithm(generatorParameters({ w, enable_short_term: shortTerm, relearning_steps: ['10m'] }));
        const curve = curveOf(w);
        for (let card = 0; card < 40; card++) {
          const g0 = 1 + Math.floor(rand() * 4);
          let ours = initState(w, g0);
          let theirs = ref.next_state(null, 0, g0);
          expect(ours).toEqual(theirs);
          for (let step = 0; step < 15; step++) {
            const t = rand() < 0.2 ? 0 : Math.floor(rand() * 60);
            const g = 1 + Math.floor(rand() * 4);
            expect(recall(curve, t, ours.stability)).toBe(ref.forgetting_curve(t, theirs.stability));
            ours = nextState(w, curve, shortTerm, ours, t, g);
            theirs = ref.next_state(theirs, t, g);
            expect(ours).toEqual(theirs);
            compared++;
          }
        }
      }
      expect(compared).toBe(6 * 40 * 15);
    });
  }
});

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

const at = (day: number, hour = 10) => START + day * DAY + hour * HOUR;

describe('buildDataset', () => {
  it('builds per-card sequences in study days', () => {
    const data = buildDataset(
      [
        { cardId: 'a', rating: 3, state: State.Review, reviewedAt: at(3) },
        { cardId: 'a', rating: 3, state: State.New, reviewedAt: at(0) },
        { cardId: 'a', rating: 1, state: State.Review, reviewedAt: at(10) },
      ],
      4,
    );
    expect(data.sequences).toEqual([{ cardId: 'a', deltas: [0, 3, 7], ratings: [3, 3, 1] }]);
    expect(data.predictions).toBe(2);
  });

  it('counts a 1am review as the previous study day', () => {
    const data = buildDataset(
      [
        { cardId: 'a', rating: 3, state: State.New, reviewedAt: at(0, 22) },
        { cardId: 'a', rating: 3, state: State.Learning, reviewedAt: at(1, 1) }, // before a 4am rollover
        { cardId: 'a', rating: 3, state: State.Review, reviewedAt: at(1, 9) },
      ],
      4,
    );
    expect(data.sequences[0].deltas).toEqual([0, 0, 1]);
    expect(data.predictions).toBe(1); // same-day reviews are not scored
  });

  it('skips cards whose history does not start at the first review', () => {
    const data = buildDataset([{ cardId: 'b', rating: 3, state: State.Review, reviewedAt: at(5) }], 4);
    expect(data.sequences).toEqual([]);
    expect(data.skippedCards).toBe(1);
  });

  it('starts a new sequence after a reset to New', () => {
    const data = buildDataset(
      [
        { cardId: 'a', rating: 3, state: State.New, reviewedAt: at(0) },
        { cardId: 'a', rating: 3, state: State.Review, reviewedAt: at(4) },
        { cardId: 'a', rating: 2, state: State.New, reviewedAt: at(20) },
        { cardId: 'a', rating: 3, state: State.Learning, reviewedAt: at(21) },
      ],
      4,
    );
    expect(data.sequences.map((s) => s.ratings)).toEqual([
      [3, 3],
      [2, 3],
    ]);
  });

  it('ignores manual (0) and out-of-range ratings', () => {
    const data = buildDataset(
      [
        { cardId: 'a', rating: 3, state: State.New, reviewedAt: at(0) },
        { cardId: 'a', rating: 0, state: State.Review, reviewedAt: at(2) },
        { cardId: 'a', rating: 9, state: State.Review, reviewedAt: at(3) },
      ],
      4,
    );
    expect(data.sequences[0].ratings).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

// A learner whose memories last much longer than the defaults assume, and
// who forgets more slowly after lapses.
const TRUE_W = clip(
  default_w.map((v, j) => (j < 4 ? v * 3 : j === 8 ? v + 0.4 : j === 11 ? v * 1.5 : v)),
  CFG,
);
const logs = simulate(TRUE_W, { cards: 600, days: 240, start: START, seed: 42 });
const data = buildDataset(logs, 4);

describe('evaluate', () => {
  it('scores the true weights better than the defaults on data they generated', () => {
    const truth = evaluate(TRUE_W, data.sequences, CFG);
    const defaults = evaluate(effectiveWeights([], CFG), data.sequences, CFG);
    expect(truth.n).toBe(data.predictions);
    expect(truth.logLoss).toBeLessThan(defaults.logLoss);
    expect(truth.rmse).toBeLessThan(defaults.rmse);
  });
});

describe('splitByCard', () => {
  it('holds out about a fifth of cards, deterministically, never splitting a card', () => {
    const a = splitByCard(data.sequences);
    const b = splitByCard(data.sequences);
    expect(a.test.map((s) => s.cardId)).toEqual(b.test.map((s) => s.cardId));
    const frac = a.test.length / data.sequences.length;
    expect(frac).toBeGreaterThan(0.12);
    expect(frac).toBeLessThan(0.28);
    const trainIds = new Set(a.train.map((s) => s.cardId));
    expect(a.test.some((s) => trainIds.has(s.cardId))).toBe(false);
  });
});

describe('optimize', () => {
  it('recovers most of the gap to the true weights, measured on held-out cards', async () => {
    const report = await trainAndCompare(data, [], CFG);
    const { test } = splitByCard(data.sequences);
    const truth = evaluate(TRUE_W, test, CFG);

    expect(report.better).toBe(true);
    expect(report.trained.logLoss).toBeLessThan(report.current.logLoss);
    // At least 60% of the way from the defaults to the truth.
    const closed = (report.current.logLoss - report.trained.logLoss) / (report.current.logLoss - truth.logLoss);
    expect(closed).toBeGreaterThan(0.6);
    expect(report.weights).toHaveLength(21);
    expect(report.weights).toEqual(clip(report.weights, CFG)); // already legal
  }, 60_000);

  it('does not recommend a change when the current weights are already the truth', async () => {
    const report = await trainAndCompare(data, TRUE_W, CFG);
    expect(report.better).toBe(false);
  }, 60_000);

  it('is stable: optimizing again from the fitted weights finds nothing meaningful to add', async () => {
    const first = await trainAndCompare(data, [], CFG);
    const second = await trainAndCompare(data, first.weights, CFG);
    expect(second.better).toBe(false);
  }, 120_000);

  it('refuses a history that is too thin', async () => {
    const thin = buildDataset(simulate(TRUE_W, { cards: 20, days: 60, start: START }), 4);
    expect(thin.predictions).toBeLessThan(MIN_PREDICTIONS);
    await expect(trainAndCompare(thin, [], CFG)).rejects.toThrow(/Not enough review history/);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const run = optimize(data.sequences, effectiveWeights([], CFG), CFG, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(run).rejects.toBeInstanceOf(OptimizationCancelled);
  });
});

describe('capTraining', () => {
  it('passes a small set through untouched', () => {
    expect(capTraining(data.sequences, 1e9)).toBe(data.sequences);
  });

  it('keeps whole cards up to roughly the budget', () => {
    const capped = capTraining(data.sequences, 500);
    const scoredIn = (seqs: typeof capped) =>
      seqs.reduce((n, s) => n + s.deltas.slice(1).filter((d) => d > 0).length, 0);
    expect(scoredIn(capped)).toBeGreaterThanOrEqual(500);
    expect(scoredIn(capped)).toBeLessThan(560);
    const ids = new Set(capped.map((s) => s.cardId));
    const whole = data.sequences.filter((s) => ids.has(s.cardId));
    expect(whole).toHaveLength(capped.length);
  });
});

describe('replay', () => {
  it('gives the same state as stepping the model by hand', () => {
    const w = effectiveWeights([], CFG);
    const seq = data.sequences[0];
    const curve = curveOf(w);
    let s = initState(w, seq.ratings[0]);
    for (let i = 1; i < seq.ratings.length; i++) s = nextState(w, curve, true, s, seq.deltas[i], seq.ratings[i]);
    expect(replay(w, seq, CFG)).toEqual(s);
  });
});
