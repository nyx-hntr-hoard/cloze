/**
 * CSV export.
 *
 * Deck-scoped and flat by design, to match what import can read back:
 * `type, text, back, reverse, extra, tags`, one row per live note. This is
 * interchange, not backup — no ids, no scheduling state, no media — so a
 * deck that mixes cloze and basic notes round-trips through this file only
 * as far as text goes; re-importing it means picking one type for the whole
 * file, same as any other CSV. A full, lossless multi-type copy is what JSON
 * backup is for.
 */

import type { Note } from '../db/types';
import { slugify, stampFilename } from '../lib/text';
import { noteTypeOf } from '../notetypes';
import { getDeck, notesInDeck } from '../repo';
import { serializeCsv } from './serialize';

const HEADER = ['type', 'text', 'back', 'reverse', 'extra', 'tags'];

export function notesToCsvRows(notes: Note[]): string[][] {
  return [
    HEADER,
    ...notes.map((note) => [
      noteTypeOf(note),
      note.text,
      note.back ?? '',
      note.reverse ? 'true' : 'false',
      note.extra,
      note.tags.join(' '),
    ]),
  ];
}

export function notesToCsvText(notes: Note[]): string {
  return serializeCsv(notesToCsvRows(notes));
}

export interface ExportedCsv {
  blob: Blob;
  filename: string;
  rowCount: number;
}

export async function exportDeckCsv(deckId: string): Promise<ExportedCsv> {
  const [deck, notes] = await Promise.all([getDeck(deckId), notesInDeck(deckId)]);
  // A UTF-8 BOM so Excel, which otherwise guesses the system codepage,
  // recognizes the file as UTF-8 and renders accented and non-Latin text
  // correctly instead of as mojibake.
  const text = `﻿${notesToCsvText(notes)}`;
  return {
    blob: new Blob([text], { type: 'text/csv;charset=utf-8' }),
    filename: `cloze-${slugify(deck?.name ?? 'deck', 'deck')}-${stampFilename(Date.now())}.csv`,
    rowCount: notes.length,
  };
}
