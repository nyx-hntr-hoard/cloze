/**
 * Dexie database definition and migration chain.
 *
 * Indexing notes:
 *  - `cards` carries a compound `[deckId+due]` index. That is the queue query:
 *    "cards in this deck due before now, in due order". Without it, every
 *    review session table-scans.
 *  - `notes.contentHash` supports import de-duplication.
 *  - `media.sha256` supports paste de-duplication (the same screenshot pasted
 *    into five notes should be stored once).
 *  - Soft-deleted rows are filtered in the repository layer, not the index.
 *    IndexedDB cannot index "field is undefined", so a `deletedAt` index would
 *    silently exclude live rows.
 *
 * Adding a version: append a new `.version(n).stores({...})` block with only
 * the tables whose *indexes* changed, plus an `.upgrade()` if existing rows
 * need rewriting. Never edit an existing version block — users' browsers have
 * already run it.
 */

import Dexie, { type EntityTable } from 'dexie';
// Types only (it brings the `db.cloud` typings); the add-on itself is loaded
// below, and only in a sync build.
import type {} from 'dexie-cloud-addon';
import { CLOUD_URL, cloudEnabled } from './cloud';

/**
 * The Dexie Cloud add-on, loaded only when this build syncs. The env check is
 * a build-time constant, so in a local-only build this whole expression folds
 * to nothing and the add-on (~230 KB) never reaches the bundle — which matters
 * for the single-file `cloze.html`.
 */
const cloudAddon =
  import.meta.env.VITE_DEXIE_CLOUD_URL && cloudEnabled ? (await import('dexie-cloud-addon')).default : null;
import {
  DEFAULT_FSRS_PARAMS,
  DEFAULT_SETTINGS,
  META_KEY,
  type Card,
  type Deck,
  type MediaItem,
  type Meta,
  type Note,
  type ProfileRow,
  type ReviewLog,
} from './types';

/** Bumped whenever the *export format* changes, independent of Dexie's version. */
export const SCHEMA_VERSION = 1;

export class ClozeDB extends Dexie {
  decks!: EntityTable<Deck, 'id'>;
  notes!: EntityTable<Note, 'id'>;
  cards!: EntityTable<Card, 'id'>;
  reviewLogs!: EntityTable<ReviewLog, 'id'>;
  media!: EntityTable<MediaItem, 'id'>;
  meta!: EntityTable<Meta, 'key'>;
  profile!: EntityTable<ProfileRow, 'id'>;

  /**
   * `cloud` activates the Dexie Cloud add-on. It has to be decided here, at
   * construction — the add-on changes how the schema below is parsed — which
   * is why it's a constructor flag rather than something switched on later.
   * Tests construct without it and get plain IndexedDB.
   */
  constructor(name = 'cloze', cloud = false) {
    super(name, cloud && cloudAddon ? { addons: [cloudAddon] } : undefined);

    this.version(1).stores({
      decks: 'id, name, modified',
      notes: 'id, deckId, contentHash, modified, *tags',
      cards: 'id, noteId, deckId, due, state, [deckId+due], [noteId+ordinal]',
      reviewLogs: 'id, cardId, deckId, reviewedAt',
      media: 'id, sha256, created',
      meta: 'key',
    });

    // v2: daily limits need "how many of each kind did I answer in this deck
    // today", which is a deck + time-range scan on every queue build. The
    // compound index turns that from a full table walk into a range read — and
    // reviewLogs is the one table that grows without bound.
    this.version(2).stores({
      reviewLogs: 'id, cardId, deckId, reviewedAt, [deckId+reviewedAt]',
    });

    // v3: the synced half of settings (see `ProfileRow`), split out of `meta`
    // so that `meta` can stay device-local under sync. No data migration:
    // reads fall back to `meta` until the first write lands here.
    this.version(3).stores({
      profile: 'id',
    });
  }
}

export const db = new ClozeDB('cloze', cloudEnabled);

if (cloudEnabled && cloudAddon) {
  db.cloud.configure({
    databaseUrl: CLOUD_URL,
    // Sign in before first use, rather than letting data be created as an
    // anonymous local user and adopted on login. Simpler to reason about, and
    // it's what a flashcard app you open on several devices wants anyway.
    requireAuth: true,
    // `meta` is this device's: theme, storage grant, schema stamp. Synced
    // settings live in `profile` (see `ProfileRow`).
    unsyncedTables: ['meta'],
    // A second script file can't load from every host this app is served
    // from; foreground sync is enough for a study app.
    tryUseServiceWorker: false,
  });
}

/**
 * Ensure the singleton meta row exists. Safe to call on every boot.
 * Returns the current meta row.
 */
export async function ensureMeta(database: ClozeDB = db): Promise<Meta> {
  const existing = await database.meta.get(META_KEY);
  if (existing) return existing;

  const now = Date.now();
  const fresh: Meta = {
    key: META_KEY,
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    fsrsParams: { ...DEFAULT_FSRS_PARAMS },
    created: now,
    modified: now,
  };
  // `put` rather than `add`: two tabs booting at once would race on `add`.
  await database.meta.put(fresh);
  return (await database.meta.get(META_KEY)) ?? fresh;
}

/**
 * Ask the browser to make this origin's storage non-evictable.
 *
 * This is the one real weakness of a browser-only app: without it, IndexedDB
 * is best-effort and can be cleared under storage pressure. The result is
 * surfaced in Settings rather than swallowed, because a user whose decks can
 * vanish deserves to know.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
