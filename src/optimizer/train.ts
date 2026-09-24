/**
 * Fitting FSRS weights to a review history.
 *
 * The objective is the one the reference optimizer (fsrs-rs) uses: binary
 * cross-entropy between the model's predicted recall probability and what
 * actually happened (Again = forgot; Hard/Good/Easy = remembered), over every
 * review that came at least a day after the previous one.
 *
 * How it differs from fsrs-rs, on purpose:
 *
 *  - **Finite-difference gradients, not autodiff.** Twenty-one parameters and
 *    a model that's cheap to replay make forward differences affordable, and
 *    they need no tensor library in a single-file offline app. Adam does the
 *    rest.
 *  - **Optimized in a normalized space.** The four initial stabilities span
 *    0.001–100 and are fitted on a log scale; every other weight is rescaled
 *    to 0–1 across its legal range. One learning rate then means the same
 *    thing for every parameter.
 *  - **Pulled gently toward the library defaults.** A small L2 penalty, which
 *    fades as the history grows, keeps a thin history from producing extreme
 *    weights that fit a few hundred reviews and nothing else. The anchor is
 *    always the defaults — never the current weights — so the objective is
 *    the same on every run: optimizing twice converges to the same answer
 *    instead of drifting a little further each time. The current weights are
 *    only the starting point.
 *  - **Judged on cards it never saw.** One card in five is held out (chosen
 *    by a hash of its id, so the split is stable), and the verdict compares
 *    current and trained weights on those cards only. An in-sample comparison
 *    would say "better" every time.
 *
 * It runs on the main thread, yielding between iterations. A Web Worker would
 * be nicer, but a worker script is a second file, and the standalone
 * `cloze.html` has to work from `file://`, where a module worker can't load.
 */

import { CLAMP_PARAMETERS, W17_W18_Ceiling, clipParameters, default_w } from 'ts-fsrs';
import type { Dataset, Sequence } from './dataset';
import { curveOf, initState, nextState, recall, type MemoryState } from './model';

/** Below this many scorable reviews the verdict would be noise. */
export const MIN_PREDICTIONS = 400;

/**
 * Training cost grows with the history; past this many scored reviews the fit
 * barely moves but the wait keeps growing, so training uses a stable subset of
 * cards that big. Evaluation on held-out cards still uses all of them.
 */
export const MAX_TRAINING_PREDICTIONS = 40_000;

function scored(seq: Sequence): number {
  let n = 0;
  for (let i = 1; i < seq.deltas.length; i++) if (seq.deltas[i] > 0) n++;
  return n;
}

/** Keep whole cards, in hash order, until the budget is spent. */
export function capTraining(train: Sequence[], budget = MAX_TRAINING_PREDICTIONS): Sequence[] {
  const total = train.reduce((sum, s) => sum + scored(s), 0);
  if (total <= budget) return train;
  const byCard = new Map<string, Sequence[]>();
  for (const s of train) {
    const list = byCard.get(s.cardId);
    if (list) list.push(s);
    else byCard.set(s.cardId, [s]);
  }
  const ids = [...byCard.keys()].sort((a, b) => fnv1a(`cap:${a}`) - fnv1a(`cap:${b}`));
  const out: Sequence[] = [];
  let used = 0;
  for (const id of ids) {
    if (used >= budget) break;
    for (const s of byCard.get(id)!) {
      out.push(s);
      used += scored(s);
    }
  }
  return out;
}

export interface Metrics {
  /** Mean binary cross-entropy — lower is better. */
  logLoss: number;
  /** Calibration error across 20 probability bins, in percentage points. */
  rmse: number;
  /** Reviews scored. */
  n: number;
}

export interface ModelConfig {
  /** Matches the scheduler's `enableShortTerm`. */
  shortTerm: boolean;
  /** Matches the scheduler's relearning-step count; it narrows w17/w18. */
  relearningSteps: number;
}

/** Legal weights, the way ts-fsrs itself will clip them when scheduling. */
export function clip(w: number[], cfg: ModelConfig): number[] {
  return clipParameters(w, cfg.relearningSteps, cfg.shortTerm);
}

/** Stored weights, or the library defaults when none are stored. */
export function effectiveWeights(stored: readonly number[], cfg: ModelConfig): number[] {
  return clip(stored.length === 21 ? [...stored] : [...default_w], cfg);
}

const EPS = 1e-4;
const BINS = 20;

export function evaluate(w: readonly number[], sequences: Sequence[], cfg: ModelConfig): Metrics {
  const curve = curveOf(w);
  let loss = 0;
  let n = 0;
  const binP = new Float64Array(BINS);
  const binY = new Float64Array(BINS);
  const binN = new Float64Array(BINS);

  for (const seq of sequences) {
    let state = initState(w, seq.ratings[0]);
    for (let i = 1; i < seq.ratings.length; i++) {
      const t = seq.deltas[i];
      const g = seq.ratings[i];
      if (t > 0) {
        const p = Math.min(1 - EPS, Math.max(EPS, recall(curve, t, state.stability)));
        const y = g > 1 ? 1 : 0;
        loss -= y ? Math.log(p) : Math.log(1 - p);
        n++;
        const b = Math.min(BINS - 1, Math.floor(p * BINS));
        binP[b] += p;
        binY[b] += y;
        binN[b]++;
      }
      state = nextState(w, curve, cfg.shortTerm, state, t, g);
    }
  }

  let sq = 0;
  for (let b = 0; b < BINS; b++) {
    if (binN[b]) sq += binN[b] * ((binP[b] - binY[b]) / binN[b]) ** 2;
  }
  return { logLoss: n ? loss / n : 0, rmse: n ? Math.sqrt(sq / n) * 100 : 0, n };
}

/** The memory state after replaying a whole sequence — for recomputing cards after new weights. */
export function replay(w: readonly number[], seq: Sequence, cfg: ModelConfig): MemoryState {
  const curve = curveOf(w);
  let state = initState(w, seq.ratings[0]);
  for (let i = 1; i < seq.ratings.length; i++) {
    state = nextState(w, curve, cfg.shortTerm, state, seq.deltas[i], seq.ratings[i]);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One card in five held out, stable across runs; a card's sequences stay together. */
export function splitByCard(sequences: Sequence[]): { train: Sequence[]; test: Sequence[] } {
  const train: Sequence[] = [];
  const test: Sequence[] = [];
  for (const seq of sequences) (fnv1a(seq.cardId) % 5 === 0 ? test : train).push(seq);
  return { train, test };
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

/** First four weights are initial stabilities, fitted on a log scale. */
const LOG_SCALED = 4;

function bounds(cfg: ModelConfig): number[][] {
  return CLAMP_PARAMETERS(W17_W18_Ceiling, cfg.shortTerm);
}

function toX(w: readonly number[], b: number[][]): number[] {
  return w.map((v, j) => (j < LOG_SCALED ? Math.log(v) : (v - b[j][0]) / (b[j][1] - b[j][0] || 1)));
}

function toW(x: readonly number[], b: number[][], cfg: ModelConfig): number[] {
  return clip(
    x.map((v, j) => (j < LOG_SCALED ? Math.exp(v) : b[j][0] + v * (b[j][1] - b[j][0]))),
    cfg,
  );
}

export interface OptimizeOptions {
  maxIterations?: number;
  /** Called after every iteration with 0–1 progress. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export class OptimizationCancelled extends Error {
  constructor() {
    super('Optimization cancelled.');
    this.name = 'OptimizationCancelled';
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Fit weights to `sequences`, starting from `start`, gently anchored to the defaults. */
export async function optimize(
  sequences: Sequence[],
  start: readonly number[],
  cfg: ModelConfig,
  options: OptimizeOptions = {},
): Promise<number[]> {
  const { maxIterations = 300, onProgress, signal } = options;
  const b = bounds(cfg);
  const anchor = toX(effectiveWeights([], cfg), b);
  const x0 = toX(clip([...start], cfg), b);
  const n = Math.max(1, evaluate(start, sequences, cfg).n);
  // The anchor fades as evidence accumulates: worth about 20 reviews' say.
  const lambda = 20 / n;

  const objective = (x: number[]): number => {
    const { logLoss } = evaluate(toW(x, b, cfg), sequences, cfg);
    let penalty = 0;
    for (let j = 0; j < x.length; j++) penalty += (x[j] - anchor[j]) ** 2;
    return Number.isFinite(logLoss) ? logLoss + lambda * penalty : Infinity;
  };

  let x = x0.slice();
  let fx = objective(x);
  let best = { x: x.slice(), f: fx };
  const m = new Array<number>(x.length).fill(0);
  const v = new Array<number>(x.length).fill(0);
  const [beta1, beta2, lr0, h] = [0.9, 0.999, 0.04, 1e-3];
  let stale = 0;

  for (let it = 1; it <= maxIterations; it++) {
    if (signal?.aborted) throw new OptimizationCancelled();

    const grad = x.map((_, j) => {
      const xh = x.slice();
      xh[j] += h;
      const d = (objective(xh) - fx) / h;
      return Number.isFinite(d) ? d : 0;
    });

    // Cosine-decayed step size: big moves early, settle at the end.
    const lr = lr0 * (0.5 + 0.5 * Math.cos((Math.PI * it) / maxIterations));
    for (let j = 0; j < x.length; j++) {
      m[j] = beta1 * m[j] + (1 - beta1) * grad[j];
      v[j] = beta2 * v[j] + (1 - beta2) * grad[j] ** 2;
      const mh = m[j] / (1 - beta1 ** it);
      const vh = v[j] / (1 - beta2 ** it);
      x[j] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
    // Keep x inside the legal box so the gradient is measured where the model lives.
    x = toX(toW(x, b, cfg), b);
    fx = objective(x);

    if (fx < best.f - 1e-6) {
      best = { x: x.slice(), f: fx };
      stale = 0;
    } else if (++stale >= 40) {
      break;
    }

    onProgress?.(it / maxIterations);
    await tick();
  }

  onProgress?.(1);
  return toW(best.x, b, cfg);
}

// ---------------------------------------------------------------------------
// The whole job
// ---------------------------------------------------------------------------

export interface OptimizationReport {
  /** The fitted weights, clipped exactly as the scheduler will clip them. */
  weights: number[];
  current: Metrics;
  trained: Metrics;
  /** True when the trained weights beat the current ones on held-out cards. */
  better: boolean;
  trainCards: number;
  testCards: number;
  predictions: number;
}

export async function trainAndCompare(
  data: Dataset,
  stored: readonly number[],
  cfg: ModelConfig,
  options: OptimizeOptions = {},
): Promise<OptimizationReport> {
  if (data.predictions < MIN_PREDICTIONS) {
    throw new Error(
      `Not enough review history yet: ${data.predictions} usable reviews, and at least ${MIN_PREDICTIONS} are needed for a result that means anything.`,
    );
  }
  const start = effectiveWeights(stored, cfg);
  const { train, test } = splitByCard(data.sequences);
  const weights = await optimize(capTraining(train), start, cfg, options);
  const current = evaluate(start, test, cfg);
  const trained = evaluate(weights, test, cfg);

  return {
    weights,
    current,
    trained,
    // Require a real margin, not rounding noise, before recommending a change.
    better: trained.logLoss < current.logLoss - 1e-4,
    trainCards: new Set(train.map((s) => s.cardId)).size,
    testCards: new Set(test.map((s) => s.cardId)).size,
    predictions: data.predictions,
  };
}
