/**
 * Review-loop tests.
 *
 * The queue is where a quiet bug is most expensive: a card silently dropped
 * from the queue is never studied again, and a daily limit that miscounts
 * either buries you or starves you.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Rating, State } from 'ts-fsrs';
import { db } from '../db/db';
import { createDeck, createNote, updateDeck, cardsForNote, DEFAULT_FSRS_PARAMS } from '../repo';
import type { Card, Deck } from '../db/types';
import { DAY, HOUR, MINUTE, dayStart } from '../lib/time';
import {
  answerCard,
  buildQueue,
  dayProgress,
  kindOf,
  LEARNING_HORIZON,
  makeScheduler,
  previewGrades,
  reinsert,
  rolloverFor,
  totalOf,
  undoAnswer,
} from './index';

const scheduler = makeScheduler(DEFAULT_FSRS_PARAMS);
let deck: Deck;

/** A fixed "now" well clear of a rollover boundary, so tests are stable. */
const NOW = new Date('2026-03-10T14:00:00').getTime();

async function seed(count: number): Promise<Card[]> {
  const made: Card[] = [];
  for (let i = 0; i < count; i++) {
    const { note } = await createNote({ deckId: deck.id, text: `fact ${i} is {{c1::${i}}}` });
    made.push(...(await cardsForNote(note.id)));
  }
  return made;
}

/**
 * Drive a card into the Review state through the scheduler rather than writing
 * a hand-made memory state. FSRS validates stability and difficulty against
 * each other, so a fabricated row is both unrealistic and rejected — and
 * scheduling it for real is what the app actually does.
 */
async function matureCard(card: Card, dueAt: number): Promise<Card> {
  let current = card;
  for (let i = 0; i < 3 && current.state !== State.Review; i++) {
    current = (await answerCard(scheduler, current, Rating.Easy, dueAt - DAY)).card;
  }
  const parked = { ...current, due: dueAt };
  await db.cards.put(parked);
  // Answers used to graduate the card are setup, not part of the test's day.
  await db.reviewLogs.where('cardId').equals(card.id).delete();
  return parked;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  deck = await createDeck({ name: 'Test' });
});

// ---------------------------------------------------------------------------
// Study day
// ---------------------------------------------------------------------------

describe('study day', () => {
  it('starts at the rollover hour, not midnight', () => {
    const start = dayStart(new Date('2026-03-10T14:00:00').getTime(), 4);
    expect(new Date(start).getHours()).toBe(4);
    expect(new Date(start).getDate()).toBe(10);
  });

  it('counts a 1am session as the previous day', () => {
    const lateNight = new Date('2026-03-11T01:00:00').getTime();
    expect(new Date(dayStart(lateNight, 4)).getDate()).toBe(10);
  });

  it('rolls over exactly at the hour', () => {
    const at4 = new Date('2026-03-11T04:00:00').getTime();
    expect(new Date(dayStart(at4, 4)).getDate()).toBe(11);
  });

  it('takes the deck rollover over the global one, falling back when unset', () => {
    expect(rolloverFor({ ...deck, config: { ...deck.config, rolloverHour: 2 } }, 4)).toBe(2);
    expect(rolloverFor(undefined, 4)).toBe(4);
    expect(rolloverFor({ ...deck, config: { ...deck.config, rolloverHour: 99 } }, 4)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

describe('buildQueue', () => {
  it('offers new cards up to the daily limit', async () => {
    await seed(30);
    await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 5 } });
    const d = (await db.decks.get(deck.id))!;

    const queue = await buildQueue(d, 4, NOW);
    expect(queue.counts.new).toBe(5);
    expect(queue.cappedNew).toBe(true);
  });

  it('offers nothing new when the limit is zero', async () => {
    await seed(5);
    await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 0 } });
    const d = (await db.decks.get(deck.id))!;
    expect((await buildQueue(d, 4, NOW)).counts.new).toBe(0);
  });

  it('treats a review limit of zero as unlimited', async () => {
    const cards = await seed(3);
    await db.cards.bulkPut(
      cards.map((c) => ({ ...c, state: State.Review, reps: 3, due: NOW - HOUR })),
    );
    await updateDeck(deck.id, { config: { ...deck.config, reviewsPerDay: 0 } });
    const d = (await db.decks.get(deck.id))!;
    expect((await buildQueue(d, 4, NOW)).counts.review).toBe(3);
  });

  it('excludes suspended and deleted cards', async () => {
    const cards = await seed(3);
    await db.cards.update(cards[0].id, { suspended: true });
    await db.cards.update(cards[1].id, { deletedAt: NOW });

    const queue = await buildQueue(deck, 4, NOW);
    expect(totalOf(queue.counts)).toBe(1);
  });

  it('excludes review cards that are not due yet', async () => {
    const cards = await seed(2);
    await db.cards.bulkPut([
      { ...cards[0], state: State.Review, reps: 2, due: NOW - HOUR },
      { ...cards[1], state: State.Review, reps: 2, due: NOW + 3 * DAY },
    ]);
    expect((await buildQueue(deck, 4, NOW)).counts.review).toBe(1);
  });

  it('orders learning first, then reviews, then new', async () => {
    const cards = await seed(3);
    await db.cards.bulkPut([
      { ...cards[0], state: State.Review, reps: 4, due: NOW - HOUR },
      { ...cards[1], state: State.Learning, reps: 1, due: NOW - MINUTE },
      // cards[2] stays new
    ]);

    const queue = await buildQueue(deck, 4, NOW);
    expect(queue.cards.map(kindOf)).toEqual(['learning', 'review', 'new']);
  });

  it('studies a learning card ahead when nothing else is left', async () => {
    // Anki's learn-ahead limit: with an empty queue, a card due in a minute is
    // handed over now rather than making you sit and wait for it.
    const cards = await seed(1);
    await db.cards.put({ ...cards[0], state: State.Learning, reps: 1, due: NOW + 5 * MINUTE });

    const queue = await buildQueue(deck, 4, NOW);
    expect(queue.cards).toHaveLength(1);
    expect(queue.counts.learning).toBe(1);
    expect(queue.nextLearningAt).toBeUndefined();
  });

  it('does not let a not-yet-due learning card jump ahead of real work', async () => {
    const cards = await seed(2);
    await db.cards.bulkPut([
      { ...cards[0], state: State.Learning, reps: 1, due: NOW + 5 * MINUTE },
      { ...cards[1], state: State.Review, reps: 4, due: NOW - HOUR },
    ]);

    const queue = await buildQueue(deck, 4, NOW);
    expect(queue.cards.map(kindOf)).toEqual(['review']);
    expect(queue.counts.learning).toBe(0);
  });

  it('waits when the only learning card is beyond the learn-ahead horizon', async () => {
    const cards = await seed(1);
    const due = NOW + LEARNING_HORIZON + MINUTE;
    await db.cards.put({ ...cards[0], state: State.Learning, reps: 1, due });

    const queue = await buildQueue(deck, 4, NOW);
    expect(queue.cards).toHaveLength(0);
    expect(queue.nextLearningAt).toBe(due);
  });

  it('agrees with reinsert about the horizon', async () => {
    // The same card must behave identically whether it stayed in the session
    // queue or arrived on a rebuild.
    const cards = await seed(1);
    const near = { ...cards[0], state: State.Learning, reps: 1, due: NOW + MINUTE };
    await db.cards.put(near);

    expect((await buildQueue(deck, 4, NOW)).cards).toHaveLength(1);
    expect(reinsert([], near, NOW)).toHaveLength(1);

    const far = { ...cards[0], state: State.Learning, reps: 1, due: NOW + 2 * HOUR };
    await db.cards.put(far);

    expect((await buildQueue(deck, 4, NOW)).cards).toHaveLength(0);
    expect(reinsert([], far, NOW)).toHaveLength(0);
  });

  it('says nothing about future learning when the deck is genuinely finished', async () => {
    const cards = await seed(1);
    await db.cards.put({ ...cards[0], state: State.Review, reps: 4, due: NOW + 10 * DAY });
    expect((await buildQueue(deck, 4, NOW)).nextLearningAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Daily limits against the log
// ---------------------------------------------------------------------------

describe('daily limits', () => {
  it('counts cards studied today against the new limit', async () => {
    await seed(10);
    await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 5 } });
    const d = (await db.decks.get(deck.id))!;

    // Answer three new cards.
    let queue = await buildQueue(d, 4, NOW);
    for (let i = 0; i < 3; i++) {
      await answerCard(scheduler, queue.cards[i], Rating.Good, NOW);
    }

    const progress = await dayProgress(deck.id, 4, NOW);
    expect(progress.newStudied).toBe(3);

    queue = await buildQueue(d, 4, NOW);
    expect(queue.counts.new).toBe(2);
  });

  it('ignores answers from a previous study day', async () => {
    const cards = await seed(10);
    await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 5 } });
    const d = (await db.decks.get(deck.id))!;

    // Five new cards answered yesterday.
    const yesterday = NOW - DAY;
    for (let i = 0; i < 5; i++) {
      await answerCard(scheduler, cards[i], Rating.Good, yesterday);
    }

    expect((await dayProgress(deck.id, 4, yesterday)).newStudied).toBe(5);
    expect((await dayProgress(deck.id, 4, NOW)).newStudied).toBe(0);
    expect((await buildQueue(d, 4, NOW)).counts.new).toBe(5);
  });

  it('does not let learning steps eat the review budget', async () => {
    const cards = await seed(4);
    await db.cards.bulkPut(
      cards.map((c) => ({ ...c, state: State.Learning, reps: 1, due: NOW - MINUTE })),
    );
    await updateDeck(deck.id, { config: { ...deck.config, reviewsPerDay: 2 } });
    const d = (await db.decks.get(deck.id))!;

    // Answering a learning card logs state=Learning, not state=Review.
    await answerCard(scheduler, cards[0], Rating.Good, NOW);
    const progress = await dayProgress(deck.id, 4, NOW);
    expect(progress.reviewsDone).toBe(0);
    expect(progress.totalAnswers).toBe(1);

    // All remaining learning cards stay available despite the review cap.
    expect((await buildQueue(d, 4, NOW)).counts.learning).toBe(3);
  });

  it('caps reviews once the budget is spent', async () => {
    await seed(5);
    await updateDeck(deck.id, { config: { ...deck.config, reviewsPerDay: 2 } });
    const d = (await db.decks.get(deck.id))!;

    // Graduate every card to Review, then re-read: answering a stale in-memory
    // card would schedule from the wrong state and log the wrong `state`.
    await Promise.all((await db.cards.toArray()).map((c) => matureCard(c, NOW - HOUR)));
    const mature = await db.cards.toArray();

    await answerCard(scheduler, mature[0], Rating.Good, NOW);
    await answerCard(scheduler, mature[1], Rating.Good, NOW);

    expect((await dayProgress(deck.id, 4, NOW)).reviewsDone).toBe(2);

    const queue = await buildQueue(d, 4, NOW);
    expect(queue.counts.review).toBe(0);
    expect(queue.cappedReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe('answering', () => {
  it('advances the card and writes exactly one log', async () => {
    const [card] = await seed(1);
    const result = await answerCard(scheduler, card, Rating.Good, NOW);

    expect(result.card.reps).toBe(1);
    expect(result.card.due).toBeGreaterThan(NOW);
    expect(result.card.state).not.toBe(State.New);

    const logs = await db.reviewLogs.toArray();
    expect(logs).toHaveLength(1);
    // The log records the state *before* the answer, which is what the new-card
    // limit and any future optimizer read.
    expect(logs[0].state).toBe(State.New);
    expect(logs[0].rating).toBe(Rating.Good);
    expect(logs[0].reviewedAt).toBe(NOW);
  });

  it('persists the advanced card', async () => {
    const [card] = await seed(1);
    await answerCard(scheduler, card, Rating.Good, NOW);
    expect((await db.cards.get(card.id))!.reps).toBe(1);
  });

  it('records how long the answer took', async () => {
    const [card] = await seed(1);
    await answerCard(scheduler, card, Rating.Good, NOW, 4200);
    expect((await db.reviewLogs.toArray())[0].durationMs).toBe(4200);
  });

  it('schedules Again sooner than Good, and Good sooner than Easy', async () => {
    const [card] = await seed(1);
    const previews = previewGrades(scheduler, card, NOW);
    const [again, hard, good, easy] = previews.map((p) => p.intervalMs);

    expect(again).toBeLessThanOrEqual(hard);
    expect(hard).toBeLessThanOrEqual(good);
    expect(good).toBeLessThan(easy);
  });

  it('previews four grades with labels the UI can show', async () => {
    const [card] = await seed(1);
    const previews = previewGrades(scheduler, card, NOW);
    expect(previews.map((p) => p.label)).toEqual(['Again', 'Hard', 'Good', 'Easy']);
    expect(previews.every((p) => p.due > NOW)).toBe(true);
  });

  it('counts a lapse when a review card is failed', async () => {
    const [card] = await seed(1);
    const mature = await matureCard(card, NOW - DAY);
    expect(mature.state).toBe(State.Review);

    const result = await answerCard(scheduler, mature, Rating.Again, NOW);
    expect(result.card.lapses).toBe(1);
    expect(result.card.state).toBe(State.Relearning);
  });

  it('rejects a card whose memory state is self-inconsistent', async () => {
    // Not reachable by authoring or reviewing, but an import (phase 6) could
    // produce it. FSRS validates stability against difficulty and throws, so
    // the review screen has to survive one bad row rather than white-screening.
    const [card] = await seed(1);
    const corrupt = { ...card, state: State.Review, reps: 6, stability: 20, difficulty: 0 };
    await expect(answerCard(scheduler, corrupt, Rating.Good, NOW)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe('undo', () => {
  it('restores the card exactly and removes the log', async () => {
    const [card] = await seed(1);
    const before = await db.cards.get(card.id);

    const result = await answerCard(scheduler, card, Rating.Easy, NOW);
    expect(await db.reviewLogs.count()).toBe(1);

    await undoAnswer(result);
    expect(await db.cards.get(card.id)).toEqual(before);
    expect(await db.reviewLogs.count()).toBe(0);
  });

  it('frees the daily allowance it had consumed', async () => {
    await seed(10);
    await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 3 } });
    const d = (await db.decks.get(deck.id))!;

    const queue = await buildQueue(d, 4, NOW);
    const first = await answerCard(scheduler, queue.cards[0], Rating.Good, NOW);
    expect((await buildQueue(d, 4, NOW)).counts.new).toBe(2);

    await undoAnswer(first);
    expect((await buildQueue(d, 4, NOW)).counts.new).toBe(3);
  });

  it('unwinds several answers in order', async () => {
    const cards = await seed(3);
    const results = [];
    for (const card of cards) results.push(await answerCard(scheduler, card, Rating.Good, NOW));

    for (const result of results.reverse()) await undoAnswer(result);

    expect(await db.reviewLogs.count()).toBe(0);
    expect((await db.cards.toArray()).every((c) => c.reps === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-session re-queueing
// ---------------------------------------------------------------------------

describe('reinsert', () => {
  const learning = (id: string, due: number): Card =>
    ({ id, due, state: State.Learning, reps: 1 }) as Card;

  it('puts a learning card back in due order', () => {
    const queue = [learning('a', NOW + MINUTE), learning('c', NOW + 10 * MINUTE)];
    const next = reinsert(queue, learning('b', NOW + 5 * MINUTE), NOW);
    expect(next.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('places a learning card ahead of reviews and new cards', () => {
    const queue = [{ id: 'r', due: NOW, state: State.Review, reps: 3 } as Card];
    const next = reinsert(queue, learning('l', NOW + MINUTE), NOW);
    expect(next.map((c) => c.id)).toEqual(['l', 'r']);
  });

  it('drops a card scheduled beyond the session horizon', () => {
    const next = reinsert([], learning('far', NOW + 2 * HOUR), NOW);
    expect(next).toHaveLength(0);
  });

  it('drops a graduated card', () => {
    const graduated = { id: 'g', due: NOW + DAY, state: State.Review, reps: 2 } as Card;
    expect(reinsert([], graduated, NOW)).toHaveLength(0);
  });

  it('does not mutate the queue it was given', () => {
    const queue: Card[] = [];
    reinsert(queue, learning('a', NOW + MINUTE), NOW);
    expect(queue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A whole session
// ---------------------------------------------------------------------------

describe('a full session', () => {
  it('drains the queue and leaves a complete log behind', async () => {
    await seed(6);
    await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 6 } });
    const d = (await db.decks.get(deck.id))!;

    let queue = (await buildQueue(d, 4, NOW)).cards;
    let now = NOW;
    let answers = 0;

    // Answer Easy so cards graduate rather than cycling through learning steps.
    while (queue.length > 0 && answers < 50) {
      const result = await answerCard(scheduler, queue[0], Rating.Easy, now);
      answers++;
      now += 5_000;
      queue = reinsert(queue.slice(1), result.card, now);
      if (queue.length === 0) queue = (await buildQueue(d, 4, now)).cards;
    }

    expect(answers).toBe(6);
    expect(await db.reviewLogs.count()).toBe(6);
    expect((await db.cards.toArray()).every((c) => c.reps > 0)).toBe(true);
    expect((await buildQueue(d, 4, now)).cards).toHaveLength(0);
  });
});
