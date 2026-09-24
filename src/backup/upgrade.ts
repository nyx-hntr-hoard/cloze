/**
 * The backup upgrade chain.
 *
 * Exported files outlive the local database, so an import has to cope with any
 * version the app has ever written. Each step takes the previous shape to the
 * next; `upgradeBackup` runs them in order.
 *
 * There is only one version today, so this file does almost nothing. It exists
 * now because the alternative is discovering, at version 2, that version 1
 * backups were written without a way to identify or convert them — and that
 * discovery happens on the day someone needs to restore.
 */

import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  type BackupFile,
} from './types';
import { withoutSyncFields } from './syncFields';

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** Raw parsed JSON, before we know it is a backup at all. */
type Unknown = Record<string, unknown>;

/** Each entry upgrades from its key version to the next. */
const STEPS: Record<number, (raw: Unknown) => Unknown> = {
  // 1 → 2 goes here when the format changes.
};

/**
 * Validate and bring a parsed file up to the current format version.
 * Returns the upgraded backup and the version it started at.
 */
export function upgradeBackup(raw: unknown): { backup: BackupFile; from: number } {
  if (raw === null || typeof raw !== 'object') {
    throw new BackupFormatError('That file is not a Cloze backup.');
  }

  const obj = raw as Unknown;

  if (obj.format !== BACKUP_MAGIC) {
    throw new BackupFormatError(
      'That file is not a Cloze backup. Choose a .json or .zip file exported from this app.',
    );
  }

  const version = typeof obj.formatVersion === 'number' ? obj.formatVersion : 0;
  if (version < 1) {
    throw new BackupFormatError('That backup has no version number and cannot be read.');
  }
  if (version > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `That backup was written by a newer version of Cloze (format ${version}, this app reads ${BACKUP_FORMAT_VERSION}). Update the app and try again.`,
    );
  }

  let current = obj;
  for (let v = version; v < BACKUP_FORMAT_VERSION; v++) {
    const step = STEPS[v];
    if (!step) {
      throw new BackupFormatError(`No upgrade path from backup format ${v} to ${v + 1}.`);
    }
    current = step(current);
  }

  return { backup: coerce(current), from: version };
}

/**
 * Fill in anything a valid backup may legitimately lack, and reject anything
 * whose core arrays are missing. Import is a boundary: a file from outside gets
 * checked rather than trusted.
 */
function coerce(raw: Unknown): BackupFile {
  const arrays = ['decks', 'notes', 'cards'] as const;
  for (const key of arrays) {
    if (!Array.isArray(raw[key])) {
      throw new BackupFormatError(`That backup is missing its "${key}" and cannot be read.`);
    }
  }

  const file = raw as unknown as BackupFile;
  return {
    ...file,
    decks: file.decks.map(withoutSyncFields),
    notes: file.notes.map(withoutSyncFields),
    cards: file.cards.map(withoutSyncFields),
    formatVersion: BACKUP_FORMAT_VERSION,
    // Older or hand-edited files may omit these; an empty list is correct.
    reviewLogs: Array.isArray(raw.reviewLogs) ? (raw.reviewLogs as BackupFile['reviewLogs']).map(withoutSyncFields) : [],
    media: Array.isArray(raw.media) ? (raw.media as BackupFile['media']) : [],
  };
}
