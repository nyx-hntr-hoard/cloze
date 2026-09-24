/**
 * The FSRS-6 memory model, as plain functions over a weight array.
 *
 * ts-fsrs already implements this — but behind a `Proxy` on its parameters,
 * which is fine for scheduling one card and roughly 30× too slow for an
 * optimizer that replays every review in the collection a few thousand times.
 * So this file restates the same formulas, line for line, including ts-fsrs's
 * rounding to 8 decimals and its clamps.
 *
 * "Line for line" is enforced, not hoped for: `model.test.ts` replays random
 * review histories through both this and `FSRSAlgorithm.next_state` and
 * requires identical results. If a ts-fsrs upgrade changes a formula, that
 * test is what fails — before a trained weight set can drift from the
 * scheduler that will use it.
 */

import { Rating } from 'ts-fsrs';

export const S_MIN = 1e-3;
const S_MAX = 36500;

export interface MemoryState {
  stability: number;
  difficulty: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** The forgetting curve's constants depend only on w[20], so compute them once per weight set. */
export interface Curve {
  decay: number;
  factor: number;
}

export function curveOf(w: readonly number[]): Curve {
  const decay = -w[20];
  return { decay, factor: round8(Math.exp(Math.log(0.9) / decay) - 1) };
}

/** Probability of recall after `t` days at stability `s`. */
export function recall(curve: Curve, t: number, s: number): number {
  return round8(Math.pow(1 + (curve.factor * t) / s, curve.decay));
}

function initDifficulty(w: readonly number[], g: number): number {
  return round8(w[4] - Math.exp((g - 1) * w[5]) + 1);
}

export function initState(w: readonly number[], g: number): MemoryState {
  return { difficulty: clamp(initDifficulty(w, g), 1, 10), stability: Math.max(w[g - 1], 0.1) };
}

function nextDifficulty(w: readonly number[], d: number, g: number): number {
  const delta = -w[6] * (g - 3);
  const next = d + round8((delta * (10 - d)) / 9);
  return clamp(round8(w[7] * initDifficulty(w, Rating.Easy) + (1 - w[7]) * next), 1, 10);
}

/**
 * The state after answering `g` (1–4) with `t` whole days elapsed since the
 * previous review. Mirrors `FSRSAlgorithm.next_state` for a non-null state.
 */
export function nextState(
  w: readonly number[],
  curve: Curve,
  shortTerm: boolean,
  state: MemoryState,
  t: number,
  g: number,
): MemoryState {
  const { difficulty: d, stability: s } = state;
  const r = recall(curve, t, s);
  let ns: number;

  if (t === 0 && shortTerm) {
    const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
    ns = round8(clamp(s * (g >= Rating.Hard ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX));
  } else if (g === Rating.Again) {
    const afterFail = round8(
      clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX),
    );
    const floor = shortTerm ? s / Math.exp(w[17] * w[18]) : s;
    ns = clamp(round8(floor), S_MIN, afterFail);
  } else {
    const hard = g === Rating.Hard ? w[15] : 1;
    const easy = g === Rating.Easy ? w[16] : 1;
    ns = round8(
      clamp(
        s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy),
        S_MIN,
        S_MAX,
      ),
    );
  }

  return { difficulty: nextDifficulty(w, d, g), stability: ns };
}
