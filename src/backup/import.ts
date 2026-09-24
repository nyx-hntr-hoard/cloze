/**
 * Import.
 *
 * Three modes, and the difference between them is what happens to identity:
 *
 *  - **add** — everything gets fresh ids. Nothing already here can be touched,
 *    so re-importing the same file twice makes two copies rather than silently
 *    overwriting your work. This is the safe default.
 *  - **merge** — decks are matched by name, notes deduplicated by content hash.
 *    New material lands; duplicates are skipped and counted.
 *  - **restore** — wipe and write the backup verbatim, ids and all. The
 *    disaster-recovery path, and the only destructive one.
 *
 * Two details that are easy to get wrong:
 *
 * **Media ids must be remapped in note text.** Media is deduplicated by hash,
 * so an imported image may resolve to a row that already exists under a
 * different id. Every `media:<id>` reference in the imported notes has to be
 * rewritten to match, or the images silently break.
 *
 * **Scheduling state is validated.** FSRS rejects a card whose stability and
 * difficulty disagree, and it throws at review time — long after the import,
 * when the connection is no longer obvious. Bad cards are reset here and
 * counted, so the damage is reported at the boundary where it entered.
 */

import { unzip } from 'fflate';
import { State } from 'ts-fsrs';
import { db } from '../db/db';
import type { Card, Deck, MediaItem, Note, ReviewLog } from '../db/types';
import { DEFAULT_DECK_CONFIG } from '../db/types';
import { hashNoteText, newId } from '../lib/id';
import { ordinalsForNote, noteHashSource } from '../notetypes';
import { updateFsrsParams, updateSettings } from '../repo';
import {
  BACKUP_ENTRY,
  type ImportOptions,
  type ImportPlan,
  type ImportResult,
  type LoadedBackup,
} from './types';
import { BackupFormatError, upgradeBackup } from './upgrade';

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

/** Read a `.json` or `.zip` backup, upgrading it to the current format. */
export async function readBackupFile(file: File | Blob): Promise<LoadedBackup> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"

  if (!isZip) {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BackupFormatError('That file is not valid JSON.');
    }
    const { backup, from } = upgradeBackup(parsed);
    return {
      backup,
      blobs: new Map(),
      container: 'json',
      ...(from === backup.formatVersion ? {} : { upgradedFrom: from }),
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, (err, data) => (err ? reject(new BackupFormatError('That zip could not be read.')) : resolve(data)));
  });

  const entry = entries[BACKUP_ENTRY];
  if (!entry) {
    throw new BackupFormatError(`That zip has no ${BACKUP_ENTRY}, so it is not a Cloze backup.`);
  }

  const { backup, from } = upgradeBackup(JSON.parse(new TextDecoder().decode(entry)));

  const blobs = new Map<string, Blob>();
  for (const item of backup.media) {
    const raw = item.path ? entries[item.path] : undefined;
    if (raw) blobs.set(item.id, new Blob([raw as BlobPart], { type: item.mime }));
    else if (item.dataBase64) blobs.set(item.id, base64ToBlob(item.dataBase64, item.mime));
  }

  return {
    backup,
    blobs,
    container: 'zip',
    ...(from === backup.formatVersion ? {} : { upgradedFrom: from }),
  };
}

function base64ToBlob(data: string, mime: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Whether a card's stored memory state is usable.
 *
 * FSRS keeps difficulty in 1–10 and stability above zero for anything past the
 * New state. A card that says it has been reviewed but carries a zeroed memory
 * state cannot be scheduled, and the library throws rather than guessing.
 */
export function hasValidMemoryState(card: Card): boolean {
  if (card.state === State.New && card.reps === 0) return true;
  if (!Number.isFinite(card.stability) || card.stability <= 0) return false;
  if (!Number.isFinite(card.difficulty) || card.difficulty < 1 || card.difficulty > 10) return false;
  return true;
}

/** Strip a card back to never-studied, keeping its identity. */
function resetCard(card: Card): Card {
  return {
    ...card,
    due: card.created,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    lastReview: undefined,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Work out what an import would do, without doing it. The UI shows this before
 * asking for confirmation — an import that silently overwrote a month of
 * reviews would be unforgivable, and a preview is how that is avoided.
 */
export async function planImport(
  loaded: LoadedBackup,
  options: ImportOptions,
): Promise<ImportPlan> {
  const { backup } = loaded;
  const existing = await db.decks.toArray();
  const byName = new Map(existing.map((d) => [d.name.toLowerCase(), d]));

  const collidingDeckNames = backup.decks
    .filter((d) => byName.has(d.name.toLowerCase()))
    .map((d) => d.name);

  let duplicates = 0;
  if (options.mode === 'merge') {
    const deckById = new Map(backup.decks.map((d) => [d.id, d]));
    for (const note of backup.notes) {
      if (note.deletedAt) continue;
      const target = byName.get((deckById.get(note.deckId)?.name ?? '').toLowerCase());
      if (!target) continue;
      const hash = note.contentHash || hashNoteText(noteHashSource(note));
      const clash = await db.notes.where('contentHash').equals(hash).first();
      if (clash && clash.deckId === target.id && !clash.deletedAt) duplicates++;
    }
  }

  const invalidCards = options.includeHistory
    ? backup.cards.filter((c) => !hasValidMemoryState(c)).length
    : 0;

  return {
    decks: backup.decks.length,
    notes: backup.notes.length,
    cards: backup.cards.length,
    reviewLogs: options.includeHistory ? backup.reviewLogs.length : 0,
    media: backup.media.length,
    duplicates,
    collidingDeckNames,
    invalidCards,
    exportedAt: backup.exportedAt,
    ...(loaded.upgradedFrom === undefined ? {} : { upgradedFrom: loaded.upgradedFrom }),
  };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** Rewrite every `media:<old>` reference in a string using the id map. */
export function remapMediaRefs(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  return text.replace(/media:([0-9a-fA-F-]{36})/g, (whole, id: string) => {
    const next = map.get(id);
    return next ? `media:${next}` : whole;
  });
}

/** Store the backup's media, reusing identical bytes already present. */
async function importMedia(loaded: LoadedBackup): Promise<{ map: Map<string, string>; added: number }> {
  const map = new Map<string, string>();
  let added = 0;

  for (const item of loaded.backup.media) {
    const blob = loaded.blobs.get(item.id);
    if (!blob) continue;

    const existing = item.sha256 ? await db.media.where('sha256').equals(item.sha256).first() : undefined;
    if (existing) {
      if (existing.id !== item.id) map.set(item.id, existing.id);
      continue;
    }

    const row: MediaItem = {
      id: item.id,
      blob,
      filename: item.filename,
      mime: item.mime,
      size: item.size || blob.size,
      sha256: item.sha256,
      created: item.created,
    };
    // An id collision with unrelated bytes is vanishingly unlikely but would be
    // silent corruption, so a fresh id is minted rather than overwriting.
    if (await db.media.get(item.id)) {
      row.id = newId();
      map.set(item.id, row.id);
    }
    await db.media.add(row);
    added++;
  }

  return { map, added };
}

export async function importBackup(
  loaded: LoadedBackup,
  options: ImportOptions,
): Promise<ImportResult> {
  return options.mode === 'restore'
    ? restore(loaded, options)
    : addOrMerge(loaded, options);
}

// --- restore --------------------------------------------------------------

async function restore(loaded: LoadedBackup, options: ImportOptions): Promise<ImportResult> {
  const { backup } = loaded;

  const cards = options.includeHistory
    ? backup.cards.map((c) => (hasValidMemoryState(c) ? c : resetCard(c)))
    : backup.cards.map(resetCard);
  const cardsReset = options.includeHistory
    ? backup.cards.filter((c) => !hasValidMemoryState(c)).length
    : 0;

  await db.transaction(
    'rw',
    db.decks,
    db.notes,
    db.cards,
    db.reviewLogs,
    db.media,
    async () => {
      await Promise.all([
        db.decks.clear(),
        db.notes.clear(),
        db.cards.clear(),
        db.reviewLogs.clear(),
        db.media.clear(),
      ]);

      await db.decks.bulkAdd(backup.decks.map(normalizeDeck));
      await db.notes.bulkAdd(backup.notes);
      await db.cards.bulkAdd(cards);
      if (options.includeHistory) await db.reviewLogs.bulkAdd(backup.reviewLogs);

      for (const item of backup.media) {
        const blob = loaded.blobs.get(item.id);
        if (!blob) continue;
        await db.media.add({
          id: item.id,
          blob,
          filename: item.filename,
          mime: item.mime,
          size: item.size || blob.size,
          sha256: item.sha256,
          created: item.created,
        });
      }
    },
  );

  if (options.includeSettings) {
    if (backup.settings) await updateSettings(backup.settings);
    if (backup.fsrsParams) await updateFsrsParams(backup.fsrsParams);
  }

  return {
    decksCreated: backup.decks.length,
    decksMerged: 0,
    notesImported: backup.notes.length,
    notesSkipped: 0,
    cardsImported: cards.length,
    reviewLogsImported: options.includeHistory ? backup.reviewLogs.length : 0,
    mediaImported: loaded.blobs.size,
    cardsReset,
  };
}

/** Older backups may lack newer config fields. */
function normalizeDeck(deck: Deck): Deck {
  return { ...deck, config: { ...DEFAULT_DECK_CONFIG, ...deck.config } };
}

// --- add / merge ----------------------------------------------------------

async function addOrMerge(loaded: LoadedBackup, options: ImportOptions): Promise<ImportResult> {
  const { backup } = loaded;
  const merging = options.mode === 'merge';

  // Media first: note text is rewritten against the resulting id map.
  const { map: mediaMap, added: mediaImported } = await importMedia(loaded);

  const result: ImportResult = {
    decksCreated: 0,
    decksMerged: 0,
    notesImported: 0,
    notesSkipped: 0,
    cardsImported: 0,
    reviewLogsImported: 0,
    mediaImported,
    cardsReset: 0,
  };

  const existingDecks = await db.decks.toArray();
  const byName = new Map(existingDecks.map((d) => [d.name.toLowerCase(), d]));
  const usedNames = new Set(existingDecks.map((d) => d.name.toLowerCase()));

  const deckMap = new Map<string, string>();
  const newDecks: Deck[] = [];

  for (const deck of backup.decks) {
    const match = merging ? byName.get(deck.name.toLowerCase()) : undefined;
    if (match) {
      deckMap.set(deck.id, match.id);
      result.decksMerged++;
      continue;
    }
    const id = newId();
    const name = uniqueName(deck.name, usedNames);
    usedNames.add(name.toLowerCase());
    newDecks.push({ ...normalizeDeck(deck), id, name, modified: Date.now() });
    deckMap.set(deck.id, id);
    result.decksCreated++;
  }

  // Which existing content hashes are already in each target deck.
  const seenHashes = new Set<string>();
  if (merging) {
    const targets = new Set(deckMap.values());
    await db.notes.each((note) => {
      if (!note.deletedAt && targets.has(note.deckId)) seenHashes.add(`${note.deckId}:${note.contentHash}`);
    });
  }

  const noteMap = new Map<string, string>();
  const notes: Note[] = [];

  for (const note of backup.notes) {
    const deckId = deckMap.get(note.deckId);
    if (!deckId) continue;

    const text = remapMediaRefs(note.text, mediaMap);
    const extra = remapMediaRefs(note.extra ?? '', mediaMap);
    const back = note.back === undefined ? undefined : remapMediaRefs(note.back, mediaMap);
    const next = { ...note, text, extra, ...(back === undefined ? {} : { back }) };
    const contentHash = hashNoteText(noteHashSource(next));

    if (merging && seenHashes.has(`${deckId}:${contentHash}`)) {
      result.notesSkipped++;
      continue;
    }
    seenHashes.add(`${deckId}:${contentHash}`);

    const id = newId();
    noteMap.set(note.id, id);
    notes.push({ ...next, id, deckId, contentHash });
    result.notesImported++;
  }

  const cards: Card[] = [];
  const cardMap = new Map<string, string>();

  for (const card of backup.cards) {
    const noteId = noteMap.get(card.noteId);
    const deckId = deckMap.get(card.deckId);
    if (!noteId || !deckId) continue;

    const id = newId();
    cardMap.set(card.id, id);

    let next: Card = { ...card, id, noteId, deckId };
    if (!options.includeHistory) {
      next = resetCard(next);
    } else if (!hasValidMemoryState(next)) {
      next = resetCard(next);
      result.cardsReset++;
    }
    cards.push(next);
    result.cardsImported++;
  }

  const logs: ReviewLog[] = [];
  if (options.includeHistory) {
    for (const log of backup.reviewLogs) {
      const cardId = cardMap.get(log.cardId);
      const deckId = deckMap.get(log.deckId);
      if (!cardId || !deckId) continue;
      logs.push({ ...log, id: newId(), cardId, deckId });
    }
    result.reviewLogsImported = logs.length;
  }

  // Drop cards whose note generates no such ordinal any more — a hand-edited
  // backup can disagree with itself, and an orphan card would sit in the queue
  // rendering nothing.
  const ordinalsByNote = new Map(notes.map((n) => [n.id, new Set(ordinalsForNote(n))]));
  const keptCards = cards.filter((c) => ordinalsByNote.get(c.noteId)?.has(c.ordinal) ?? false);
  const droppedIds = new Set(cards.filter((c) => !keptCards.includes(c)).map((c) => c.id));
  const keptLogs = logs.filter((l) => !droppedIds.has(l.cardId));
  result.cardsImported = keptCards.length;
  result.reviewLogsImported = keptLogs.length;

  await db.transaction('rw', db.decks, db.notes, db.cards, db.reviewLogs, async () => {
    if (newDecks.length) await db.decks.bulkAdd(newDecks);
    if (notes.length) await db.notes.bulkAdd(notes);
    if (keptCards.length) await db.cards.bulkAdd(keptCards);
    if (keptLogs.length) await db.reviewLogs.bulkAdd(keptLogs);
  });

  return result;
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
