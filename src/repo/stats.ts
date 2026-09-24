/**
 * Reads for the stats screen and the optimizer, and the one write the
 * optimizer makes: applying trained weights.
 */

import { db } from '../db/db';
import type { Card, FsrsParams, Millis, ReviewLog } from '../db/types';
import { buildDataset, effectiveWeights, replay, type Dataset, type ModelConfig, type Sequence } from '../optimizer';
import { kindOf } from '../review/queue';
import { getFsrsParams, getSettings, updateFsrsParams } from './meta';

/** Live cards and recent logs, for one deck or all of them. */
export async function loadStatsData(
  deckId: string | null,
  since: Millis,
): Promise<{ cards: Card[]; logs: ReviewLog[] }> {
  if (deckId) {
    const [cards, logs] = await Promise.all([
      db.cards.where('deckId').equals(deckId).filter((c) => !c.deletedAt).toArray(),
      db.reviewLogs.where('[deckId+reviewedAt]').between([deckId, since], [deckId, Infinity]).toArray(),
    ]);
    return { cards, logs };
  }
  const [cards, logs] = await Promise.all([
    db.cards.filter((c) => !c.deletedAt).toArray(),
    db.reviewLogs.where('reviewedAt').aboveOrEqual(since).toArray(),
  ]);
  return { cards, logs };
}

/** The optimizer's view of the scheduler settings it has to agree with. */
export function modelConfigFor(params: FsrsParams): ModelConfig {
  return {
    shortTerm: params.enableShortTerm,
    relearningSteps: params.relearningSteps.filter((s) => /^\d+(\.\d+)?[mhd]$/.test(s.trim())).length || 1,
  };
}

/** Every review ever logged, as training sequences, plus the settings to train against. */
export async function loadTrainingData(): Promise<{ data: Dataset; params: FsrsParams; config: ModelConfig }> {
  const [logs, params, settings] = await Promise.all([db.reviewLogs.toArray(), getFsrsParams(), getSettings()]);
  return { data: buildDataset(logs, settings.rolloverHour), params, config: modelConfigFor(params) };
}

export interface ApplyResult {
  /** Cards whose stability/difficulty were recomputed from their history. */
  recomputed: number;
  /** Studied cards left as they were because their history is incomplete. */
  kept: number;
}

/**
 * Save new weights and bring every card's memory state in line with them.
 *
 * A card's stability and difficulty were computed by the *old* weights; left
 * alone, the next review would combine new weights with an old estimate of the
 * memory. So each studied card with a complete history is replayed under the
 * new weights — the same replay the optimizer scored. Due dates are not
 * touched: nothing is rescheduled, the next answer simply starts from a
 * better estimate. Cards whose history doesn't reach back to their first
 * review keep their state, since there is nothing to replay.
 *
 * `w` empty restores the library defaults, with the same recomputation, and
 * clears `optimizedAt`.
 */
export async function applyWeights(w: number[], optimizedAt?: Millis): Promise<ApplyResult> {
  return db.transaction('rw', [db.meta, db.profile, db.cards, db.reviewLogs], async () => {
    const [settings, logs, cards] = await Promise.all([
      getSettings(),
      db.reviewLogs.toArray(),
      db.cards.toArray(),
    ]);
    const next = await updateFsrsParams({ w, optimizedAt: w.length ? optimizedAt : undefined });
    const cfg = modelConfigFor(next);
    const weights = effectiveWeights(w, cfg);

    // The latest sequence per card is its current memory.
    const latest = new Map<string, Sequence>();
    for (const seq of buildDataset(logs, settings.rolloverHour).sequences) latest.set(seq.cardId, seq);

    const updates: { key: string; changes: Partial<Card> }[] = [];
    let kept = 0;
    for (const card of cards) {
      if (card.deletedAt || kindOf(card) === 'new') continue;
      const seq = latest.get(card.id);
      if (!seq) {
        kept++;
        continue;
      }
      const { stability, difficulty } = replay(weights, seq, cfg);
      // Only the memory estimate — a review synced in from another device
      // meanwhile keeps its due date and state.
      updates.push({ key: card.id, changes: { stability, difficulty } });
    }
    if (updates.length) await db.cards.bulkUpdate(updates);
    return { recomputed: updates.length, kept };
  });
}
