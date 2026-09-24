/**
 * The backup format.
 *
 * This is the only artefact that outlives the local database, so it gets its
 * own version number, independent of Dexie's. `formatVersion` is bumped
 * whenever the envelope changes shape, and every import runs the upgrade chain
 * in `upgrade.ts` before anything touches the database.
 *
 * The `media` field exists from version 1 even though the UI for attaching
 * images arrives later. Adding it afterwards would mean versioning the format
 * twice and writing an upgrade for backups that never needed one.
 */

import type { Card, Deck, FsrsParams, Note, ReviewLog, Settings } from '../db/types';

export const BACKUP_FORMAT_VERSION = 1;

/** Marker so a stray JSON file is rejected with a useful message. */
export const BACKUP_MAGIC = 'cloze-backup';

/** Where the media bytes live inside a zip backup. */
export const MEDIA_DIR = 'media';

/** The single JSON document, whether standalone or inside the zip. */
export const BACKUP_ENTRY = 'backup.json';

/**
 * Media metadata. Bytes travel one of two ways:
 *
 *  - in a zip backup, as files under `media/`, referenced by `path`
 *  - in a plain JSON backup, inline as base64 in `dataBase64`
 *
 * Zip is preferred whenever there is any media: base64 inflates bytes by about
 * a third, and screenshots make that the difference between a file you can mail
 * and one you cannot.
 */
export interface BackupMedia {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  created: number;
  path?: string;
  dataBase64?: string;
}

export interface BackupFile {
  format: typeof BACKUP_MAGIC;
  formatVersion: number;
  /** The database schema version at export time, for diagnostics. */
  schemaVersion: number;
  exportedAt: number;
  /** Present on a whole-collection backup, absent on a single-deck export. */
  settings?: Settings;
  fsrsParams?: FsrsParams;
  decks: Deck[];
  notes: Note[];
  cards: Card[];
  reviewLogs: ReviewLog[];
  media: BackupMedia[];
}

/** A parsed backup plus any media bytes that came alongside it. */
export interface LoadedBackup {
  backup: BackupFile;
  /** Media id → bytes. Empty when the backup carries no media. */
  blobs: Map<string, Blob>;
  /** How the file arrived, for the UI to report. */
  container: 'json' | 'zip';
  /** Set when the file was written by an older format and upgraded on load. */
  upgradedFrom?: number;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportMode =
  /** Everything arrives as new decks. Nothing existing is touched. */
  | 'add'
  /** Decks are matched by name; duplicate notes are skipped. */
  | 'merge'
  /** Wipe the database and restore the backup exactly. Destructive. */
  | 'restore';

export interface ImportOptions {
  mode: ImportMode;
  /**
   * Keep scheduling state and review history. Turning this off imports the
   * material as brand-new cards — useful for a deck shared by someone else,
   * whose review history says nothing about your memory.
   */
  includeHistory: boolean;
  /** Restore only: also overwrite app settings and FSRS parameters. */
  includeSettings: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  mode: 'add',
  includeHistory: true,
  includeSettings: false,
};

/** What an import would do, computed before anything is written. */
export interface ImportPlan {
  decks: number;
  notes: number;
  cards: number;
  reviewLogs: number;
  media: number;
  /** Notes whose content already exists in the deck they would land in. */
  duplicates: number;
  /** Deck names in the backup that already exist here. */
  collidingDeckNames: string[];
  /** Cards whose stored memory state is unusable and would be reset. */
  invalidCards: number;
  exportedAt: number;
  upgradedFrom?: number;
}

export interface ImportResult {
  decksCreated: number;
  decksMerged: number;
  notesImported: number;
  notesSkipped: number;
  cardsImported: number;
  reviewLogsImported: number;
  mediaImported: number;
  cardsReset: number;
}
