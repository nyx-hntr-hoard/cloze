/**
 * Export.
 *
 * A backup is either a plain `.json` file or a `.zip` containing that same
 * JSON plus a `media/` folder. Plain JSON when there is no media: it is
 * diffable, greppable and survives being committed to a git repo, which is a
 * real way people keep decks. Zip as soon as there is media, because base64
 * inside JSON inflates the bytes by about a third and makes a screenshot-heavy
 * deck unmailable.
 */

import { zip } from 'fflate';
import { db, SCHEMA_VERSION } from '../db/db';
import type { Card, Deck, Note, ReviewLog } from '../db/types';
import { mediaIdsIn } from '../cloze';
import { slugify, stampFilename } from '../lib/text';
import { noteFields } from '../notetypes';
import { getFsrsParams, getSettings } from '../repo';
import {
  BACKUP_ENTRY,
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  MEDIA_DIR,
  type BackupFile,
  type BackupMedia,
} from './types';
import { withoutSyncFields } from './syncFields';

export interface ExportBundle {
  backup: BackupFile;
  blobs: Map<string, Blob>;
}

/**
 * Gather a backup from the database.
 *
 * With no `deckIds`, this is the whole collection including settings — the
 * disaster-recovery artefact. With `deckIds`, it is a shareable subset and
 * settings are left out, since someone else's daily limits are not yours.
 *
 * Soft-deleted notes and cards are included deliberately: they still hold
 * review history, and a backup that quietly drops them would make "restore"
 * lossy in a way nobody would notice until they needed it.
 */
export async function collectBackup(deckIds?: string[]): Promise<ExportBundle> {
  const whole = deckIds === undefined;

  const decks: Deck[] = whole
    ? await db.decks.toArray()
    : await db.decks.where('id').anyOf(deckIds).toArray();

  const ids = decks.map((d) => d.id);
  const idSet = new Set(ids);

  const notes: Note[] = whole
    ? await db.notes.toArray()
    : (await db.notes.where('deckId').anyOf(ids).toArray()).filter((n) => idSet.has(n.deckId));
  const cards: Card[] = whole
    ? await db.cards.toArray()
    : (await db.cards.where('deckId').anyOf(ids).toArray()).filter((c) => idSet.has(c.deckId));
  const reviewLogs: ReviewLog[] = whole
    ? await db.reviewLogs.toArray()
    : (await db.reviewLogs.where('deckId').anyOf(ids).toArray()).filter((l) => idSet.has(l.deckId));

  // Only the media these notes actually reference. A partial export should not
  // drag along every image in the collection. `noteFields` covers a basic
  // note's back as well as the shared text and extra.
  const wanted = new Set<string>();
  for (const note of notes) {
    for (const field of noteFields(note)) {
      for (const id of mediaIdsIn(field)) wanted.add(id);
    }
  }

  const media: BackupMedia[] = [];
  const blobs = new Map<string, Blob>();
  for (const item of await db.media.toArray()) {
    if (!wanted.has(item.id)) continue;
    media.push({
      id: item.id,
      filename: item.filename,
      mime: item.mime,
      size: item.size,
      sha256: item.sha256,
      created: item.created,
      path: `${MEDIA_DIR}/${item.id}${extensionFor(item.mime, item.filename)}`,
    });
    blobs.set(item.id, item.blob);
  }

  const backup: BackupFile = {
    format: BACKUP_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    decks: decks.map(withoutSyncFields),
    notes: notes.map(withoutSyncFields),
    cards: cards.map(withoutSyncFields),
    reviewLogs: reviewLogs.map(withoutSyncFields),
    media,
    ...(whole ? { settings: await getSettings(), fsrsParams: await getFsrsParams() } : {}),
  };

  return { backup, blobs };
}

/** A sensible file extension for a stored blob. */
function extensionFor(mime: string, filename: string): string {
  const fromName = /\.[a-z0-9]{2,5}$/i.exec(filename);
  if (fromName) return fromName[0].toLowerCase();
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
  };
  return known[mime] ?? '.bin';
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedBackup {
  blob: Blob;
  filename: string;
  container: 'json' | 'zip';
}

export async function serializeBackup(bundle: ExportBundle): Promise<SerializedBackup> {
  const { backup, blobs } = bundle;

  const base =
    backup.settings !== undefined
      ? `cloze-backup-${stampFilename(backup.exportedAt)}`
      : `cloze-${slugify(backup.decks[0]?.name ?? 'export', 'deck')}-${stampFilename(backup.exportedAt)}`;

  if (blobs.size === 0) {
    // No media: a plain JSON file, pretty-printed so it diffs usefully.
    const json = JSON.stringify(backup, null, 2);
    return {
      blob: new Blob([json], { type: 'application/json' }),
      filename: `${base}.json`,
      container: 'json',
    };
  }

  const files: Record<string, Uint8Array> = {};
  for (const item of backup.media) {
    const blob = blobs.get(item.id);
    if (!blob || !item.path) continue;
    files[item.path] = new Uint8Array(await blob.arrayBuffer());
  }
  files[BACKUP_ENTRY] = new TextEncoder().encode(JSON.stringify(backup, null, 2));

  const archive = await new Promise<Uint8Array>((resolve, reject) => {
    // Images are already compressed; spending time deflating them again buys
    // almost nothing, so only the JSON is compressed.
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  return {
    blob: new Blob([archive as BlobPart], { type: 'application/zip' }),
    filename: `${base}.zip`,
    container: 'zip',
  };
}

/** Gather and serialize in one step. */
export async function exportBackup(deckIds?: string[]): Promise<SerializedBackup> {
  return serializeBackup(await collectBackup(deckIds));
}

/**
 * Hand the file to the browser's download machinery.
 *
 * The object URL is revoked on the next frame rather than immediately: some
 * browsers have not started the download by the time the click handler returns.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
