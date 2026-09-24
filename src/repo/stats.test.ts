import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { State, default_w } from 'ts-fsrs';
import { db } from '../db/db';
import type { ReviewLog } from '../db/types';
import { DAY } from '../lib/time';
import { buildDataset, effectiveWeights, replay } from '../optimizer';
import { cardsForNote } from './cards';
import { createDeck } from './decks';
import { getFsrsParams } from './meta';
import { createNote } from './notes';
import { applyWeights, loadStatsData, loadTrainingData, modelConfigFor } from './stats';

const T0 = new Date(2026, 0, 5, 10).getTime();

function logFor(cardId: string, deckId: string, day: number, rating: number, state: State): ReviewLog {
  return {
    id: `${cardId}-${day}`,
    cardId,
    deckId,
    rating,
    state,
    due: 0,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    lastElapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reviewedAt: T0 + day * DAY,
  };
}

let deckA: string;
let deckB: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  deckA = (await createDeck({ name: 'A' })).id;
  deckB = (await createDeck({ name: 'B' })).id;
});

async function studiedCard(deckId: string, withHistory: boolean) {
  const { note } = await createNote({ deckId, text: `{{c1::x${Math.random()}}}` });
  const [card] = await cardsForNote(note.id);
  await db.cards.update(card.id, { state: State.Review, reps: 3, stability: 42, difficulty: 5 });
  if (withHistory) {
    await db.reviewLogs.bulkAdd([
      logFor(card.id, deckId, 0, 3, State.New),
      logFor(card.id, deckId, 3, 3, State.Review),
      logFor(card.id, deckId, 12, 1, State.Review),
      logFor(card.id, deckId, 13, 3, State.Relearning),
    ]);
  }
  return card.id;
}

describe('loadStatsData', () => {
  it('filters cards and logs by deck and by time', async () => {
    const a = await studiedCard(deckA, true);
    await studiedCard(deckB, true);
    const all = await loadStatsData(null, 0);
    expect(all.cards).toHaveLength(2);
    expect(all.logs).toHaveLength(8);

    const onlyA = await loadStatsData(deckA, T0 + 5 * DAY);
    expect(onlyA.cards.map((c) => c.id)).toEqual([a]);
    expect(onlyA.logs).toHaveLength(2); // days 12 and 13
  });
});

describe('applyWeights', () => {
  it('saves the weights and recomputes studied cards from their history', async () => {
    const withLogs = await studiedCard(deckA, true);
    const withoutLogs = await studiedCard(deckA, false);
    const w = default_w.map((v, j) => (j < 4 ? v * 2 : v));

    const result = await applyWeights(w);
    expect(result).toEqual({ recomputed: 1, kept: 1 });

    const params = await getFsrsParams();
    expect(params.w).toEqual(w);

    const cfg = modelConfigFor(params);
    const { data } = await loadTrainingData();
    const expected = replay(effectiveWeights(w, cfg), data.sequences[0], cfg);
    const card = await db.cards.get(withLogs);
    expect({ stability: card!.stability, difficulty: card!.difficulty }).toEqual(expected);

    const untouched = await db.cards.get(withoutLogs);
    expect(untouched!.stability).toBe(42);
  });

  it('leaves due dates alone', async () => {
    const id = await studiedCard(deckA, true);
    const before = (await db.cards.get(id))!.due;
    await applyWeights(default_w.map((v) => v * 1.1));
    expect((await db.cards.get(id))!.due).toBe(before);
  });

  it('an empty weight list resets to the defaults, recomputing with them', async () => {
    const id = await studiedCard(deckA, true);
    await applyWeights(default_w.map((v, j) => (j < 4 ? v * 3 : v)));
    await applyWeights([]);
    expect((await getFsrsParams()).w).toEqual([]);
    const cfg = modelConfigFor(await getFsrsParams());
    const logs = await db.reviewLogs.toArray();
    const seq = buildDataset(logs, 4).sequences[0];
    const card = await db.cards.get(id);
    expect(card!.stability).toBe(replay(effectiveWeights([], cfg), seq, cfg).stability);
  });
});
