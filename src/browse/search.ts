/**
 * Indexing, filtering and sorting for the browse screen.
 *
 * Split in two on purpose. `indexNotes` does the expensive part — rendering
 * every note to plain text so cloze markup doesn't leak into matches — and
 * runs once per database change. `searchIndex` is cheap enough to run on
 * every keystroke over the result. Re-rendering 5,000 notes per keypress is
 * the difference between a search box that keeps up and one that stutters.
 *
 * Everything here is pure: the route loads the rows, this decides what to
 * show. That keeps the query semantics testable without a database.
 */

import type { Card, Deck, Millis, Note } from '../db/types';
import { renderPlain, segmentsToText, splitMedia } from '../cloze';
import { noteSummaryOf, noteTypeOf } from '../notetypes';
import { kindOf } from '../review/queue';
import { fold, globRegex, type CardFlag, type Clause, type ParsedQuery } from './query';

export interface BrowseEntry {
  note: Note;
  deckName: string;
  /** Live cards only. */
  cards: Card[];
  summary: string;
  /** Folded plain text of every field, for text clauses. */
  haystack: string;
  /** Folded tags, for tag clauses. */
  foldedTags: string[];
}

export interface BrowseData {
  notes: Note[];
  cards: Card[];
  decks: Deck[];
}

/** Plain text of a note: deletions shown, media collapsed to `[alt]`. */
function plainText(note: Note): string {
  const front =
    noteTypeOf(note) === 'cloze'
      ? segmentsToText(renderPlain(note.text))
      : segmentsToText(splitMedia(note.text));
  const back = note.back ? segmentsToText(splitMedia(note.back)) : '';
  const extra = note.extra ? segmentsToText(splitMedia(note.extra)) : '';
  return [front, back, extra].filter(Boolean).join('\n');
}

export function indexNotes({ notes, cards, decks }: BrowseData): BrowseEntry[] {
  const deckNames = new Map(decks.map((d) => [d.id, d.name]));
  const cardsByNote = new Map<string, Card[]>();
  for (const card of cards) {
    if (card.deletedAt) continue;
    const list = cardsByNote.get(card.noteId);
    if (list) list.push(card);
    else cardsByNote.set(card.noteId, [card]);
  }

  const out: BrowseEntry[] = [];
  for (const note of notes) {
    if (note.deletedAt) continue;
    out.push({
      note,
      deckName: deckNames.get(note.deckId) ?? '(missing deck)',
      cards: (cardsByNote.get(note.id) ?? []).sort((a, b) => a.ordinal - b.ordinal),
      summary: noteSummaryOf(note, 160),
      haystack: fold(plainText(note)),
      foldedTags: note.tags.map(fold),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface Clock {
  /** Start of the current study day — `added:1` means "since then". */
  todayStart: Millis;
  /** End of the current study day — `is:due` means "due before then". */
  dueBy: Millis;
}

function cardHasFlag(card: Card, flag: Exclude<CardFlag, 'empty'>, clock: Clock): boolean {
  switch (flag) {
    case 'suspended':
      return card.suspended;
    case 'due':
      // Matches what the review screen would offer today: never new cards,
      // never suspended ones.
      return !card.suspended && kindOf(card) !== 'new' && card.due < clock.dueBy;
    default:
      return kindOf(card) === flag;
  }
}

/** `added:N` counts study days, so `added:1` is "today", not "the last 24 hours". */
function sinceDays(clock: Clock, days: number): Millis {
  const d = new Date(clock.todayStart);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

/** Compile once per query rather than once per note. */
type Test = (entry: BrowseEntry) => boolean;

function compile(clause: Clause, clock: Clock): Test {
  switch (clause.kind) {
    case 'text': {
      const re = globRegex(clause.pattern, false);
      return (e) => re.test(e.haystack);
    }
    case 'tag': {
      const re = globRegex(clause.pattern, true);
      return (e) => e.foldedTags.some((t) => re.test(t));
    }
    case 'untagged':
      return (e) => e.note.tags.length === 0;
    case 'deck': {
      const re = globRegex(clause.pattern, true);
      return (e) => re.test(fold(e.deckName));
    }
    case 'type':
      return (e) => noteTypeOf(e.note) === clause.value;
    case 'is':
      if (clause.value === 'empty') return (e) => e.cards.length === 0;
      return (e) => e.cards.some((c) => cardHasFlag(c, clause.value as Exclude<CardFlag, 'empty'>, clock));
    case 'added': {
      const since = sinceDays(clock, clause.days);
      return (e) => e.note.created >= since;
    }
    case 'edited': {
      const since = sinceDays(clock, clause.days);
      return (e) => e.note.modified >= since;
    }
  }
}

export function filterEntries(entries: BrowseEntry[], query: ParsedQuery, clock: Clock): BrowseEntry[] {
  if (query.clauses.length === 0) return entries.slice();
  const tests = query.clauses.map((c) => {
    const test = compile(c, clock);
    return c.negate ? (e: BrowseEntry) => !test(e) : test;
  });
  return entries.filter((e) => tests.every((t) => t(e)));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey = 'note' | 'deck' | 'due' | 'added' | 'edited';
export type SortDir = 'asc' | 'desc';

/** The next due date worth showing: earliest among cards the queue would serve. */
export function nextDue(entry: BrowseEntry): Millis | null {
  let best: Millis | null = null;
  for (const c of entry.cards) {
    if (c.suspended || kindOf(c) === 'new') continue;
    if (best === null || c.due < best) best = c.due;
  }
  return best;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sortEntries(entries: BrowseEntry[], key: SortKey, dir: SortDir): BrowseEntry[] {
  const sign = dir === 'asc' ? 1 : -1;
  const dues = key === 'due' ? new Map(entries.map((e) => [e, nextDue(e)])) : null;

  const cmp = (a: BrowseEntry, b: BrowseEntry): number => {
    switch (key) {
      case 'note':
        return collator.compare(a.summary, b.summary);
      case 'deck':
        return collator.compare(a.deckName, b.deckName);
      case 'added':
        return a.note.created - b.note.created;
      case 'edited':
        return a.note.modified - b.note.modified;
      case 'due': {
        const da = dues!.get(a)!;
        const db = dues!.get(b)!;
        // Nothing scheduled sorts last in either direction: "no due date" is
        // not earlier or later than any date, it's just not in the list.
        if (da === null || db === null) return 0;
        return da - db;
      }
    }
  };

  return entries.slice().sort((a, b) => {
    if (key === 'due') {
      const da = dues!.get(a)!;
      const db = dues!.get(b)!;
      if (da === null && db !== null) return 1;
      if (db === null && da !== null) return -1;
    }
    // Newest-edited as the tiebreak keeps equal-keyed rows in a stable,
    // meaningful order instead of whatever IndexedDB returned.
    return sign * cmp(a, b) || b.note.modified - a.note.modified;
  });
}
