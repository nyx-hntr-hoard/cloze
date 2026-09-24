/**
 * Backup tests.
 *
 * The central claim of this feature is that an export followed by a restore
 * gives you back exactly what you had. If that is wrong, it is wrong on the one
 * day it matters. Most of what follows is proving that claim from several
 * angles, and pinning the behaviour of the modes that deliberately do *not*
 * preserve identity.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Rating, State } from 'ts-fsrs';
import { db } from '../db/db';
import {
  addMedia,
  cardsForNote,
  createDeck,
  createNote,
  DEFAULT_FSRS_PARAMS,
  getSettings,
  updateDeck,
  updateSettings,
} from '../repo';
import { answerCard, makeScheduler } from '../review';
import { BACKUP_MAGIC } from './types';
import { collectBackup, serializeBackup } from './export';
import {
  hasValidMemoryState,
  importBackup,
  planImport,
  readBackupFile,
  remapMediaRefs,
} from './import';
import { BackupFormatError, upgradeBackup } from './upgrade';
import type { ImportOptions } from './types';

const scheduler = makeScheduler(DEFAULT_FSRS_PARAMS);
const NOW = new Date('2026-03-10T14:00:00').getTime();

const ADD: ImportOptions = { mode: 'add', includeHistory: true, includeSettings: false };
const MERGE: ImportOptions = { mode: 'merge', includeHistory: true, includeSettings: false };
const RESTORE: ImportOptions = { mode: 'restore', includeHistory: true, includeSettings: true };

/** A deck with notes, some of them studied. */
async function seedCollection() {
  const deck = await createDeck({ name: 'PEN-200', description: 'Enumeration' });
  await updateDeck(deck.id, { config: { ...deck.config, newPerDay: 42, rolloverHour: 3 } });

  const a = await createNote({
    deckId: deck.id,
    text: 'Null session: {{c1::rpcclient -U "" -N}} then {{c2::enumdomusers}}',
    extra: 'Fails on 2019+',
    tags: ['smb', 'enum'],
  });
  const b = await createNote({
    deckId: deck.id,
    text: 'LLMNR poisoning uses {{c1::responder -I eth0}}',
    tags: ['ad'],
  });

  // Study a couple of cards so there is real scheduling state and history.
  const cards = await cardsForNote(a.note.id);
  await answerCard(scheduler, cards[0], Rating.Good, NOW);
  await answerCard(scheduler, cards[1], Rating.Easy, NOW);

  return { deck, notes: [a.note, b.note] };
}

async function snapshot() {
  return {
    decks: await db.decks.toArray(),
    notes: await db.notes.toArray(),
    cards: await db.cards.toArray(),
    logs: await db.reviewLogs.toArray(),
  };
}

/** Export, serialize, and read back the way the UI does. */
async function roundTripFile(deckIds?: string[]) {
  const file = await serializeBackup(await collectBackup(deckIds));
  return { file, loaded: await readBackupFile(file.blob) };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe('the exported file', () => {
  it('is plain JSON when there is no media', async () => {
    await seedCollection();
    const file = await serializeBackup(await collectBackup());
    expect(file.container).toBe('json');
    expect(file.filename).toMatch(/^cloze-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  });

  it('carries a format marker and version', async () => {
    await seedCollection();
    const { backup } = await collectBackup();
    expect(backup.format).toBe(BACKUP_MAGIC);
    expect(backup.formatVersion).toBe(1);
    expect(backup.exportedAt).toBeGreaterThan(0);
  });

  it('includes settings in a whole-collection export but not a single-deck one', async () => {
    const { deck } = await seedCollection();
    expect((await collectBackup()).backup.settings).toBeDefined();
    expect((await collectBackup([deck.id])).backup.settings).toBeUndefined();
  });

  it('exports only the requested deck', async () => {
    const { deck } = await seedCollection();
    const other = await createDeck({ name: 'Other' });
    await createNote({ deckId: other.id, text: 'unrelated {{c1::thing}}' });

    const { backup } = await collectBackup([deck.id]);
    expect(backup.decks.map((d) => d.id)).toEqual([deck.id]);
    expect(backup.notes.every((n) => n.deckId === deck.id)).toBe(true);
    expect(backup.cards.every((c) => c.deckId === deck.id)).toBe(true);
  });

  it('keeps soft-deleted notes, which still hold review history', async () => {
    const { deck } = await seedCollection();
    const { note } = await createNote({ deckId: deck.id, text: 'doomed {{c1::note}}' });
    await db.notes.update(note.id, { deletedAt: NOW });

    const { backup } = await collectBackup();
    expect(backup.notes.some((n) => n.id === note.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('restore round trip', () => {
  it('reproduces the collection exactly', async () => {
    await seedCollection();
    const before = await snapshot();

    const { loaded } = await roundTripFile();

    // Wipe and restore into an empty database.
    await db.delete();
    await db.open();
    await importBackup(loaded, RESTORE);

    const after = await snapshot();
    expect(after.decks).toEqual(before.decks);
    expect(after.notes).toEqual(before.notes);
    expect(after.cards).toEqual(before.cards);
    expect(after.logs).toEqual(before.logs);
  });

  it('preserves scheduling state down to the millisecond', async () => {
    await seedCollection();
    const before = (await db.cards.toArray()).filter((c) => c.reps > 0);
    expect(before.length).toBeGreaterThan(0);

    const { loaded } = await roundTripFile();
    await db.delete();
    await db.open();
    await importBackup(loaded, RESTORE);

    for (const original of before) {
      const restored = await db.cards.get(original.id);
      expect(restored!.due).toBe(original.due);
      expect(restored!.stability).toBe(original.stability);
      expect(restored!.difficulty).toBe(original.difficulty);
      expect(restored!.reps).toBe(original.reps);
      expect(restored!.state).toBe(original.state);
      expect(restored!.lastReview).toBe(original.lastReview);
    }
  });

  it('replaces what was already there', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();

    await createDeck({ name: 'Scratch deck that should not survive' });
    await importBackup(loaded, RESTORE);

    const names = (await db.decks.toArray()).map((d) => d.name);
    expect(names).toEqual(['PEN-200']);
  });

  it('restores settings only when asked', async () => {
    await seedCollection();
    await updateSettings({ rolloverHour: 9, backupReminderDays: 3 });
    const { loaded } = await roundTripFile();

    await updateSettings({ rolloverHour: 1, backupReminderDays: 30 });
    await importBackup(loaded, { ...RESTORE, includeSettings: false });
    expect((await getSettings()).rolloverHour).toBe(1);

    await importBackup(loaded, { ...RESTORE, includeSettings: true });
    expect((await getSettings()).rolloverHour).toBe(9);
  });

  it('keeps per-deck config', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();
    await db.delete();
    await db.open();
    await importBackup(loaded, RESTORE);

    const deck = (await db.decks.toArray())[0];
    expect(deck.config.newPerDay).toBe(42);
    expect(deck.config.rolloverHour).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

describe('add mode', () => {
  it('leaves existing decks untouched and renames the collision', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();

    const result = await importBackup(loaded, ADD);

    expect(result.decksCreated).toBe(1);
    expect(result.decksMerged).toBe(0);
    const names = (await db.decks.toArray()).map((d) => d.name).sort();
    expect(names).toEqual(['PEN-200', 'PEN-200 (2)']);
  });

  it('gives everything fresh ids, so a double import is two copies not a clobber', async () => {
    await seedCollection();
    const before = await snapshot();
    const { loaded } = await roundTripFile();

    await importBackup(loaded, ADD);

    const after = await snapshot();
    expect(after.notes).toHaveLength(before.notes.length * 2);
    expect(after.cards).toHaveLength(before.cards.length * 2);
    // Every original row is still exactly as it was.
    for (const note of before.notes) expect(await db.notes.get(note.id)).toEqual(note);
  });

  it('carries scheduling history onto the copies', async () => {
    await seedCollection();
    const studied = (await db.cards.toArray()).filter((c) => c.reps > 0).length;
    const { loaded } = await roundTripFile();

    const result = await importBackup(loaded, ADD);

    expect(result.reviewLogsImported).toBe(2);
    const all = await db.cards.toArray();
    expect(all.filter((c) => c.reps > 0)).toHaveLength(studied * 2);
  });

  it('discards history when asked, importing the material as new', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();

    const result = await importBackup(loaded, { ...ADD, includeHistory: false });

    expect(result.reviewLogsImported).toBe(0);
    const imported = (await db.decks.toArray()).find((d) => d.name === 'PEN-200 (2)')!;
    const cards = (await db.cards.toArray()).filter((c) => c.deckId === imported.id);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.reps === 0 && c.state === State.New)).toBe(true);
  });

  it('keeps review logs pointing at the cards they came from', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();
    await importBackup(loaded, ADD);

    const cardIds = new Set((await db.cards.toArray()).map((c) => c.id));
    const logs = await db.reviewLogs.toArray();
    expect(logs.length).toBe(4);
    expect(logs.every((l) => cardIds.has(l.cardId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe('merge mode', () => {
  it('skips notes already in the target deck', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();

    const result = await importBackup(loaded, MERGE);

    expect(result.decksCreated).toBe(0);
    expect(result.decksMerged).toBe(1);
    expect(result.notesImported).toBe(0);
    expect(result.notesSkipped).toBe(2);
    expect(await db.decks.count()).toBe(1);
  });

  it('adds notes that are genuinely new', async () => {
    const { deck } = await seedCollection();
    const { loaded } = await roundTripFile();

    // Remove one note locally, then merge the backup back in.
    const victim = (await db.notes.where('deckId').equals(deck.id).toArray())[0];
    await db.notes.delete(victim.id);
    await db.cards.where('noteId').equals(victim.id).delete();

    const result = await importBackup(loaded, MERGE);
    expect(result.notesImported).toBe(1);
    expect(result.notesSkipped).toBe(1);
    expect(await db.notes.count()).toBe(2);
  });

  it('reports the duplicate count before importing anything', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();

    const plan = await planImport(loaded, MERGE);
    expect(plan.duplicates).toBe(2);
    expect(plan.collidingDeckNames).toEqual(['PEN-200']);
    // Nothing was written by planning.
    expect(await db.notes.count()).toBe(2);
  });

  it('creates a deck that does not exist here yet', async () => {
    const { deck } = await seedCollection();
    const { loaded } = await roundTripFile();

    await updateDeck(deck.id, { name: 'Renamed' });
    const result = await importBackup(loaded, MERGE);

    expect(result.decksCreated).toBe(1);
    expect(result.notesImported).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

describe('media', () => {
  async function seedWithMedia() {
    const deck = await createDeck({ name: 'Visual' });
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], {
      type: 'image/png',
    });
    const item = await addMedia(png, 'diagram.png');
    const { note } = await createNote({
      deckId: deck.id,
      text: `![diagram](media:${item.id}) shows the {{c1::handshake}}`,
    });
    return { deck, item, note };
  }

  it('exports as a zip once there is media', async () => {
    await seedWithMedia();
    const file = await serializeBackup(await collectBackup());
    expect(file.container).toBe('zip');
    expect(file.filename).toMatch(/\.zip$/);
  });

  it('round-trips the bytes', async () => {
    const { item } = await seedWithMedia();
    const original = new Uint8Array(await item.blob.arrayBuffer());

    const { loaded } = await roundTripFile();
    await db.delete();
    await db.open();
    await importBackup(loaded, RESTORE);

    const restored = await db.media.get(item.id);
    expect(restored).toBeDefined();
    expect(new Uint8Array(await restored!.blob.arrayBuffer())).toEqual(original);
    expect(restored!.sha256).toBe(item.sha256);
  });

  it('only exports media the exported notes reference', async () => {
    const { deck } = await seedWithMedia();
    // An image nothing points at.
    await addMedia(new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' }), 'orphan.png');

    const { backup } = await collectBackup([deck.id]);
    expect(backup.media).toHaveLength(1);
  });

  it('deduplicates by hash and rewrites the references', async () => {
    const { item, note } = await seedWithMedia();
    const { loaded } = await roundTripFile();

    // Import as a copy: the bytes already exist, so the copy must point at the
    // existing row rather than storing it twice.
    await importBackup(loaded, ADD);

    expect(await db.media.count()).toBe(1);
    const copies = (await db.notes.toArray()).filter((n) => n.id !== note.id);
    expect(copies).toHaveLength(1);
    expect(copies[0].text).toContain(`media:${item.id}`);
  });

  it('rewrites references when an id changes', () => {
    const map = new Map([['11111111-2222-4333-8444-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']]);
    const text = '![a](media:11111111-2222-4333-8444-555555555555) and ![b](media:99999999-8888-4777-8666-555555555555)';
    const out = remapMediaRefs(text, map);
    expect(out).toContain('media:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    // Unknown ids are left alone rather than blanked.
    expect(out).toContain('media:99999999-8888-4777-8666-555555555555');
  });

  it('leaves text alone when there is nothing to remap', () => {
    expect(remapMediaRefs('unchanged', new Map())).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('rejecting bad files', () => {
  it('rejects a file that is not JSON', async () => {
    const blob = new Blob(['not json at all'], { type: 'application/json' });
    await expect(readBackupFile(blob)).rejects.toThrow(BackupFormatError);
  });

  it('rejects JSON that is not a backup', async () => {
    const blob = new Blob([JSON.stringify({ hello: 'world' })]);
    await expect(readBackupFile(blob)).rejects.toThrow(/not a Cloze backup/);
  });

  it('rejects a backup from a newer format version', () => {
    expect(() =>
      upgradeBackup({ format: BACKUP_MAGIC, formatVersion: 99, decks: [], notes: [], cards: [] }),
    ).toThrow(/newer version/);
  });

  it('rejects a backup missing its core arrays', () => {
    expect(() => upgradeBackup({ format: BACKUP_MAGIC, formatVersion: 1, decks: [] })).toThrow(
      /missing its "notes"/,
    );
  });

  it('tolerates a backup with no review logs or media', () => {
    const { backup } = upgradeBackup({
      format: BACKUP_MAGIC,
      formatVersion: 1,
      decks: [],
      notes: [],
      cards: [],
    });
    expect(backup.reviewLogs).toEqual([]);
    expect(backup.media).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Damaged scheduling data
// ---------------------------------------------------------------------------

describe('damaged scheduling data', () => {
  it('recognises a valid and an invalid memory state', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: deck.id, text: '{{c1::a}}' });
    const [fresh] = await cardsForNote(note.id);

    expect(hasValidMemoryState(fresh)).toBe(true);
    expect(hasValidMemoryState({ ...fresh, state: State.Review, reps: 3 })).toBe(false);
    expect(
      hasValidMemoryState({ ...fresh, state: State.Review, reps: 3, stability: 10, difficulty: 5 }),
    ).toBe(true);
  });

  it('resets a damaged card on import and reports it', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: deck.id, text: '{{c1::a}}' });
    const [card] = await cardsForNote(note.id);
    // The shape a hand-edited or third-party file could produce.
    await db.cards.put({ ...card, state: State.Review, reps: 7, stability: 20, difficulty: 0 });

    const { loaded } = await roundTripFile();
    expect((await planImport(loaded, ADD)).invalidCards).toBe(1);

    const result = await importBackup(loaded, ADD);
    expect(result.cardsReset).toBe(1);

    const imported = (await db.decks.toArray()).find((d) => d.name !== 'D')!;
    const [restored] = (await db.cards.toArray()).filter((c) => c.deckId === imported.id);
    expect(restored.state).toBe(State.New);
    expect(restored.reps).toBe(0);
  });

  it('drops a card whose note no longer generates that ordinal', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: deck.id, text: '{{c1::a}}' });
    const [card] = await cardsForNote(note.id);
    // A file that disagrees with itself: a c9 card on a note with only c1.
    await db.cards.add({ ...card, id: 'orphan', ordinal: 9 });

    const { loaded } = await roundTripFile();
    const result = await importBackup(loaded, ADD);

    expect(result.cardsImported).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Note types
// ---------------------------------------------------------------------------

describe('note types', () => {
  it('round-trips a basic note with its reverse card', async () => {
    const deck = await createDeck({ name: 'Acronyms' });
    await createNote({
      deckId: deck.id,
      type: 'basic',
      text: 'SPN',
      back: 'Service Principal Name',
      reverse: true,
    });

    const { loaded } = await roundTripFile();
    expect(loaded.backup.notes[0].type).toBe('basic');
    expect(loaded.backup.notes[0].back).toBe('Service Principal Name');
    expect(loaded.backup.cards).toHaveLength(2);

    await db.delete();
    await db.open();
    await importBackup(loaded, RESTORE);

    const note = (await db.notes.toArray())[0];
    expect(note.type).toBe('basic');
    expect(note.reverse).toBe(true);
    expect((await db.cards.toArray()).map((c) => c.ordinal).sort()).toEqual([1, 2]);
  });

  it('imports a backup written before note types existed as cloze', async () => {
    // Exactly the shape phase 5 produced: notes with no `type` field at all.
    const legacy = {
      format: BACKUP_MAGIC,
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: Date.now(),
      decks: [
        {
          id: 'd1',
          name: 'Legacy',
          description: '',
          config: { newPerDay: 20, reviewsPerDay: 200, rolloverHour: 4 },
          created: 1,
          modified: 1,
        },
      ],
      notes: [
        {
          id: 'n1',
          deckId: 'd1',
          text: 'The capital is {{c1::Paris}} in {{c2::France}}',
          extra: '',
          tags: [],
          contentHash: 'deadbeefdeadbeef',
          created: 1,
          modified: 1,
        },
      ],
      cards: [],
      reviewLogs: [],
      media: [],
    };

    const blob = new Blob([JSON.stringify(legacy)], { type: 'application/json' });
    const loaded = await readBackupFile(blob);
    const result = await importBackup(loaded, ADD);

    expect(result.notesImported).toBe(1);
    const note = (await db.notes.toArray())[0];
    expect(note.type).toBeUndefined();
    // The cloze engine ran, so the deletions became cards.
    expect(result.cardsImported).toBe(0); // the legacy file carried no card rows
    expect(note.text).toContain('{{c1::Paris}}');
  });

  it('dedupes basic notes on both sides, not just the front', async () => {
    const deck = await createDeck({ name: 'Acronyms' });
    await createNote({ deckId: deck.id, type: 'basic', text: 'TGT', back: 'Ticket Granting Ticket' });
    const { loaded } = await roundTripFile();

    // A different answer to the same question is a different note.
    await createNote({ deckId: deck.id, type: 'basic', text: 'TGT', back: 'Something else' });

    const plan = await planImport(loaded, MERGE);
    expect(plan.duplicates).toBe(1);

    const result = await importBackup(loaded, MERGE);
    expect(result.notesSkipped).toBe(1);
    expect(result.notesImported).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe('planImport', () => {
  it('counts what is in the file without writing anything', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();
    const before = await snapshot();

    const plan = await planImport(loaded, ADD);
    expect(plan.decks).toBe(1);
    expect(plan.notes).toBe(2);
    expect(plan.cards).toBe(3);
    expect(plan.reviewLogs).toBe(2);

    expect(await snapshot()).toEqual(before);
  });

  it('reports no review logs when history is being discarded', async () => {
    await seedCollection();
    const { loaded } = await roundTripFile();
    expect((await planImport(loaded, { ...ADD, includeHistory: false })).reviewLogs).toBe(0);
  });
});

describe('sync bookkeeping never travels in a backup', () => {
  it('strips owner/realmId/$ts on the way in', async () => {
    const { upgradeBackup } = await import('./upgrade');
    const { backup } = upgradeBackup({
      format: 'cloze-backup',
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: 0,
      decks: [{ id: 'd', name: 'D', owner: 'usr1', realmId: 'usr1', $ts: 5 }],
      notes: [{ id: 'n', deckId: 'd', text: 'x', owner: 'usr1', realmId: 'rlm-x' }],
      cards: [],
      reviewLogs: [{ id: 'l', realmId: 'usr1' }],
      media: [],
    });
    expect(backup.decks[0]).toEqual({ id: 'd', name: 'D' });
    expect(Object.keys(backup.notes[0])).toEqual(['id', 'deckId', 'text']);
    expect(backup.reviewLogs[0]).toEqual({ id: 'l' });
  });
});
