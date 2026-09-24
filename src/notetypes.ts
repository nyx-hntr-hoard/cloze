/**
 * Note types.
 *
 * A note is either **cloze** (text with `{{cN::…}}` deletions) or **basic** (a
 * front and a back). This module is the single place that knows the difference:
 * everything downstream — reconciliation, review, backup — asks it which cards
 * a note generates and how they render, and never branches on type itself.
 *
 * Basic notes map onto the existing machinery rather than sitting beside it.
 * A basic note generates ordinal 1, and ordinal 2 as well when `reverse` is on.
 * Because `reconcileCards` already takes an ordinal list, the entire card
 * lifecycle — creation, soft delete, restore, scheduling, history, export —
 * works for basic notes without a line of change. Turning `reverse` off retires
 * card 2 and keeps its review history, exactly as removing a `{{c2::…}}` does.
 *
 * That is also why the type is an *optional* field defaulting to cloze: no
 * schema migration, and old backups import unchanged.
 */

import {
  parseCloze,
  renderCardFrom,
  segmentsToText,
  splitMedia,
  type Diagnostic,
  type RenderedCard,
  type Segment,
} from './cloze';
import type { Note } from './db/types';

export type NoteType = 'cloze' | 'basic';

/** Front→back. */
export const FORWARD = 1;
/** Back→front, when the note asks for the reverse card. */
export const REVERSE = 2;

/** The fields any of this needs — so callers can pass a draft, not just a Note. */
export interface NoteLike {
  type?: NoteType;
  text: string;
  back?: string;
  reverse?: boolean;
  extra?: string;
}

/** Absent means cloze, which is what every note written before basic existed is. */
export function noteTypeOf(note: NoteLike): NoteType {
  return note.type === 'basic' ? 'basic' : 'cloze';
}

/**
 * A note being authored. Same shape as a stored note minus its identity, with
 * every field present so the editor's inputs stay controlled.
 */
export interface NoteDraft {
  type: NoteType;
  text: string;
  back: string;
  reverse: boolean;
  extra: string;
  tags: string[];
}

export const EMPTY_DRAFT: NoteDraft = {
  type: 'cloze',
  text: '',
  back: '',
  reverse: false,
  extra: '',
  tags: [],
};

export function draftFromNote(note: Note): NoteDraft {
  return {
    type: noteTypeOf(note),
    text: note.text,
    back: note.back ?? '',
    reverse: note.reverse ?? false,
    extra: note.extra,
    tags: [...note.tags],
  };
}

// ---------------------------------------------------------------------------
// Card generation
// ---------------------------------------------------------------------------

/**
 * Which cards this note generates. The answer feeds `reconcileCards`, so it has
 * to be total: any draft, however incomplete, yields a defined list.
 */
export function ordinalsForNote(note: NoteLike): number[] {
  if (noteTypeOf(note) === 'cloze') return parseCloze(note.text).ordinals;

  // A half-typed basic note generates nothing rather than a card that asks or
  // answers nothing.
  if (note.text.trim() === '' || (note.back ?? '').trim() === '') return [];
  return note.reverse ? [FORWARD, REVERSE] : [FORWARD];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function basicSides(note: NoteLike, ordinal: number): { question: string; answer: string } {
  const front = note.text;
  const back = note.back ?? '';
  return ordinal === REVERSE ? { question: back, answer: front } : { question: front, answer: back };
}

/**
 * Render one card of a note.
 *
 * A basic card's back shows the question, a rule, then the answer — so you can
 * see what you were asked while you grade yourself. A cloze card's back is the
 * same sentence with the blank filled in, which already carries its question.
 */
export function renderNoteCard(note: NoteLike, ordinal: number): RenderedCard {
  if (noteTypeOf(note) === 'cloze') {
    return renderCardFrom(parseCloze(note.text), ordinal);
  }

  const { question, answer } = basicSides(note, ordinal);
  const front: Segment[] = splitMedia(question);
  const back: Segment[] = [...front, { kind: 'divider' }, ...splitMedia(answer)];
  return { ordinal, front, back };
}

/** Every card the note generates, in ordinal order. */
export function renderNoteCards(note: NoteLike): RenderedCard[] {
  if (noteTypeOf(note) === 'cloze') {
    const parsed = parseCloze(note.text);
    return parsed.ordinals.map((n) => renderCardFrom(parsed, n));
  }
  return ordinalsForNote(note).map((n) => renderNoteCard(note, n));
}

/**
 * The answer a card is testing, as plain text — for the editor preview's
 * "→ answer" line. Cloze cards carry it in their revealed segments; basic cards
 * carry it below the divider.
 */
export function cardAnswerText(card: RenderedCard): string {
  const revealed: string[] = [];
  for (const seg of card.back) {
    if (seg.kind === 'reveal' && !revealed.includes(seg.text)) revealed.push(seg.text);
  }
  if (revealed.length) return revealed.join(' · ');

  const rule = card.back.findIndex((s) => s.kind === 'divider');
  return rule === -1 ? '' : segmentsToText(card.back.slice(rule + 1)).trim();
}

/** A one-line description for browse lists. */
export function noteSummaryOf(note: NoteLike, maxLength = 120): string {
  const raw =
    noteTypeOf(note) === 'cloze'
      ? segmentsToText(renderNoteCards(note)[0]?.back ?? splitMedia(note.text))
      : `${note.text} → ${note.back ?? ''}`;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Looks like cloze markup, which does nothing on a basic note. */
const CLOZE_MARKUP = /\{\{c\d+::/;

export function diagnoseNote(note: NoteLike): Diagnostic[] {
  if (noteTypeOf(note) === 'cloze') return parseCloze(note.text).diagnostics;

  const out: Diagnostic[] = [];
  const back = note.back ?? '';

  if (note.text.trim() === '') {
    out.push({
      severity: 'error',
      code: 'empty-front',
      message: 'This card has nothing on the front.',
      start: 0,
      end: 0,
    });
  }
  if (back.trim() === '') {
    out.push({
      severity: 'error',
      code: 'empty-back',
      message: 'This card has nothing on the back.',
      start: 0,
      end: 0,
    });
  }
  if (CLOZE_MARKUP.test(note.text) || CLOZE_MARKUP.test(back)) {
    out.push({
      severity: 'warning',
      code: 'cloze-in-basic',
      message:
        'Cloze markup shows literally on a basic card. Switch this note to Cloze to make it a deletion.',
      start: 0,
      end: 0,
    });
  }

  return out;
}

export interface NoteSummary {
  type: NoteType;
  cardCount: number;
  ordinals: number[];
  diagnostics: Diagnostic[];
  /** True when something would produce a wrong card, not merely a poor one. */
  hasError: boolean;
}

/** One call for the editor's status line and save guard. */
export function summarizeNote(note: NoteLike): NoteSummary {
  const diagnostics = diagnoseNote(note);
  const ordinals = ordinalsForNote(note);
  return {
    type: noteTypeOf(note),
    ordinals,
    cardCount: ordinals.length,
    diagnostics,
    hasError: diagnostics.some((d) => d.severity === 'error'),
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * What de-duplication hashes.
 *
 * A basic note has to include its back: two cards sharing a front but answering
 * differently are different notes, and hashing the front alone would make an
 * import silently drop one of them.
 */
export function noteHashSource(note: NoteLike): string {
  return noteTypeOf(note) === 'basic' ? `basic\u0000${note.text}\u0000${note.back ?? ''}` : note.text;
}

/** Media referenced anywhere on the note, whichever type it is. */
export function noteFields(note: NoteLike): string[] {
  const fields = [note.text, note.extra ?? ''];
  if (noteTypeOf(note) === 'basic') fields.push(note.back ?? '');
  return fields;
}

export type { Note };
