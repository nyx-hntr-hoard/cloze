/**
 * Note repository.
 *
 * Note writes always run card reconciliation in the same transaction, so a
 * note and its cards can never drift apart. Which cards a note generates is
 * decided entirely by `src/notetypes.ts`, which is also the only thing here
 * that knows cloze notes from basic ones.
 *
 * Saving is deliberately permissive: a note with parse errors is still stored,
 * and its diagnostics come back on the result for the caller to surface. The
 * editor refuses to save on an error; bulk import does not, because one
 * malformed row should not abort a thousand good ones. The soft-delete rule in
 * `reconcileCards` is what makes that safe — a bad save retires cards, it never
 * destroys their history.
 */

import type { Diagnostic } from '../cloze';
import { db } from '../db/db';
import type { Card, Millis, Note } from '../db/types';
import { hashNoteText, newId } from '../lib/id';
import { diagnoseNote, noteHashSource, ordinalsForNote, type NoteType } from '../notetypes';
import { reconcileCards } from './cards';

export interface NoteInput {
  deckId: string;
  /** Defaults to cloze. */
  type?: NoteType;
  /** Cloze: the full text. Basic: the front. */
  text: string;
  /** Basic only: the back. */
  back?: string;
  /** Basic only: also generate the reverse card. */
  reverse?: boolean;
  extra?: string;
  tags?: string[];
}

export interface SaveNoteResult {
  note: Note;
  cards: Card[];
  /** Parse diagnostics for the saved text, for the editor to display. */
  diagnostics: Diagnostic[];
}

/** Trim, hyphenate inner whitespace, de-duplicate and sort. Every tag write goes through this. */
export function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().replace(/\s+/g, '-');
    if (t) seen.add(t);
  }
  return [...seen].sort();
}

export async function getNote(id: string): Promise<Note | undefined> {
  return db.notes.get(id);
}

export async function notesInDeck(deckId: string, includeDeleted = false): Promise<Note[]> {
  const rows = await db.notes.where('deckId').equals(deckId).toArray();
  const live = includeDeleted ? rows : rows.filter((n) => !n.deletedAt);
  return live.sort((a, b) => b.modified - a.modified);
}

export async function countNotes(deckId: string): Promise<number> {
  let n = 0;
  await db.notes
    .where('deckId')
    .equals(deckId)
    .each((note) => {
      if (!note.deletedAt) n++;
    });
  return n;
}

/** Every tag used in a deck, for the editor's suggestions. */
export async function tagsInDeck(deckId: string): Promise<string[]> {
  const seen = new Set<string>();
  await db.notes
    .where('deckId')
    .equals(deckId)
    .each((note) => {
      if (note.deletedAt) return;
      for (const tag of note.tags) seen.add(tag);
    });
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Find an existing live note with the same normalized text, for import dedupe. */
export async function findByContentHash(contentHash: string, deckId?: string): Promise<Note | undefined> {
  const matches = await db.notes.where('contentHash').equals(contentHash).toArray();
  return matches.find((n) => !n.deletedAt && (deckId === undefined || n.deckId === deckId));
}

/** `type: 'cloze'` is the default, so it is left off the row entirely. */
function withType(note: Note): Note {
  if (note.type !== 'basic') delete note.type;
  if (note.type !== 'basic') {
    delete note.back;
    delete note.reverse;
  }
  return note;
}

export async function createNote(input: NoteInput, now: Millis = Date.now()): Promise<SaveNoteResult> {
  const text = input.text.trim();
  if (!text) throw new Error('Note text cannot be empty.');

  const note: Note = withType({
    id: newId(),
    deckId: input.deckId,
    type: input.type,
    text,
    back: input.back?.trim(),
    reverse: input.reverse,
    extra: input.extra?.trim() ?? '',
    tags: cleanTags(input.tags),
    contentHash: '',
    created: now,
    modified: now,
  });
  note.contentHash = hashNoteText(noteHashSource(note));

  const ordinals = ordinalsForNote(note);
  const diagnostics = diagnoseNote(note);

  return db.transaction('rw', db.notes, db.cards, async () => {
    await db.notes.add(note);
    const res = await reconcileCards(note.id, note.deckId, ordinals, now);
    return {
      note,
      cards: [...res.created, ...res.restored, ...res.unchanged],
      diagnostics,
    };
  });
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'text' | 'back' | 'reverse' | 'type' | 'extra' | 'tags' | 'deckId'>>,
  now: Millis = Date.now(),
): Promise<SaveNoteResult> {
  return db.transaction('rw', db.notes, db.cards, async () => {
    const existing = await db.notes.get(id);
    if (!existing) throw new Error(`Note ${id} not found.`);

    const text = patch.text !== undefined ? patch.text.trim() : existing.text;
    if (!text) throw new Error('Note text cannot be empty.');

    const note: Note = withType({
      ...existing,
      type: patch.type ?? existing.type,
      text,
      back: patch.back !== undefined ? patch.back.trim() : existing.back,
      reverse: patch.reverse !== undefined ? patch.reverse : existing.reverse,
      extra: patch.extra !== undefined ? patch.extra.trim() : existing.extra,
      tags: patch.tags !== undefined ? cleanTags(patch.tags) : existing.tags,
      deckId: patch.deckId ?? existing.deckId,
      contentHash: '',
      modified: now,
    });
    note.contentHash = hashNoteText(noteHashSource(note));

    // A field-level update, not a whole-row put: with sync on, a tag or deck
    // change made to this note on another device isn't reverted by this save
    // unless this save changed that field too. `undefined` deletes a field,
    // which is how a cloze note sheds `back`/`reverse` (see `withType`).
    await db.notes.update(note.id, {
      type: note.type,
      text: note.text,
      back: note.back,
      reverse: note.reverse,
      extra: note.extra,
      tags: note.tags,
      deckId: note.deckId,
      contentHash: note.contentHash,
      modified: note.modified,
    });
    const res = await reconcileCards(note.id, note.deckId, ordinalsForNote(note), now);
    return {
      note,
      cards: [...res.created, ...res.restored, ...res.unchanged],
      diagnostics: diagnoseNote(note),
    };
  });
}

/** Soft-delete a note and all of its cards. */
export async function deleteNote(id: string, now: Millis = Date.now()): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    await db.notes.update(id, { deletedAt: now });
    await db.cards.where('noteId').equals(id).modify({ deletedAt: now });
  });
}

export async function restoreNote(id: string): Promise<void> {
  await db.transaction('rw', db.notes, db.cards, async () => {
    const note = await db.notes.get(id);
    if (!note) return;
    // `modify` with an explicit `delete` removes the property outright; passing
    // `undefined` to `update` is not a reliable way to unset a field.
    await db.notes.where('id').equals(id).modify((n) => {
      delete n.deletedAt;
    });
    await reconcileCards(id, note.deckId, ordinalsForNote(note));
  });
}
