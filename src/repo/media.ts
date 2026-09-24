/**
 * Media repository.
 *
 * Images are stored as `Blob`s in IndexedDB and referenced from note text as
 * `![alt](media:<id>)`. Storing bytes rather than data URIs keeps note text
 * small and keeps export able to write a real `media/` folder instead of
 * base64 bloat.
 *
 * Object URLs are cached and reference-counted here rather than created ad hoc
 * in components: a review session that mints a fresh blob URL on every render
 * leaks memory for as long as the tab is open.
 */

import { db } from '../db/db';
import type { MediaItem, Millis } from '../db/types';
import { newId, sha256Blob } from '../lib/id';
import { noteFields } from '../notetypes';

/** `media:<id>` reference pattern used inside note text. */
export const MEDIA_REF = /media:([0-9a-fA-F-]{36})/g;

export async function getMedia(id: string): Promise<MediaItem | undefined> {
  return db.media.get(id);
}

/**
 * Store a blob, returning the existing item if the same bytes are already
 * present. Pasting the same screenshot into ten notes stores it once.
 */
export async function addMedia(blob: Blob, filename = 'image', now: Millis = Date.now()): Promise<MediaItem> {
  const sha256 = await sha256Blob(blob);
  const existing = await db.media.where('sha256').equals(sha256).first();
  if (existing) return existing;

  const item: MediaItem = {
    id: newId(),
    blob,
    filename,
    mime: blob.type || 'application/octet-stream',
    size: blob.size,
    sha256,
    created: now,
  };
  await db.media.add(item);
  return item;
}

/**
 * Every media id referenced by any live note.
 *
 * Goes through `noteFields` (the same dispatch `notetypes.ts` uses for backup
 * and hashing) rather than a hardcoded `[text, extra]`, so a basic note's back
 * field counts as "in use" too — otherwise its media would look orphaned to
 * the audit below and be a candidate for deletion despite still being shown.
 */
export async function referencedMediaIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  await db.notes.each((note) => {
    if (note.deletedAt) return;
    for (const field of noteFields(note)) {
      MEDIA_REF.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MEDIA_REF.exec(field)) !== null) ids.add(m[1]);
    }
  });
  return ids;
}

export interface MediaAudit {
  /** How many blobs are stored, orphaned or not — for "N files, X MB" in Settings. */
  totalCount: number;
  /** Stored blobs no live note references. Safe to delete. */
  orphans: MediaItem[];
  /** Ids referenced by notes with no stored blob. These render as broken. */
  dangling: string[];
  totalBytes: number;
}

/** Backs the "check media" maintenance tool. */
export async function auditMedia(): Promise<MediaAudit> {
  const referenced = await referencedMediaIds();
  const stored = await db.media.toArray();
  const storedIds = new Set(stored.map((m) => m.id));

  return {
    totalCount: stored.length,
    orphans: stored.filter((m) => !referenced.has(m.id)),
    dangling: [...referenced].filter((id) => !storedIds.has(id)),
    totalBytes: stored.reduce((sum, m) => sum + m.size, 0),
  };
}

export async function deleteMedia(ids: string[]): Promise<void> {
  for (const id of ids) releaseObjectUrl(id);
  await db.media.bulkDelete(ids);
}

// ---------------------------------------------------------------------------
// Object URL cache
// ---------------------------------------------------------------------------

interface CachedUrl {
  url: string;
  mime: string;
  refs: number;
}

const urlCache = new Map<string, CachedUrl>();

/**
 * Get (or create) a blob URL for a media id, plus its mime type so a caller
 * can pick `<img>` vs `<audio>` without a separate lookup. Every call must be
 * released.
 */
export async function acquireObjectUrl(id: string): Promise<{ url: string; mime: string } | null> {
  const hit = urlCache.get(id);
  if (hit) {
    hit.refs++;
    return hit;
  }
  const item = await db.media.get(id);
  if (!item) return null;
  const url = URL.createObjectURL(item.blob);
  urlCache.set(id, { url, mime: item.mime, refs: 1 });
  return { url, mime: item.mime };
}

export function releaseObjectUrl(id: string): void {
  const hit = urlCache.get(id);
  if (!hit) return;
  hit.refs--;
  if (hit.refs <= 0) {
    URL.revokeObjectURL(hit.url);
    urlCache.delete(id);
  }
}

/** Revoke everything. Called on teardown and after a destructive import. */
export function clearObjectUrls(): void {
  for (const { url } of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}
