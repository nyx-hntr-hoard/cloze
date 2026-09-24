/**
 * Media repository tests.
 *
 * Runs against fake-indexeddb, like the other repo tests — `db.media.add`
 * round-tripping a real `Blob` through structured clone is exactly the kind
 * of thing a mock would paper over.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { createDeck } from './decks';
import { createNote, deleteNote } from './notes';
import { acquireObjectUrl, addMedia, auditMedia, deleteMedia, referencedMediaIds, releaseObjectUrl } from './media';

let deckId: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  const deck = await createDeck({ name: 'Test' });
  deckId = deck.id;
});

function png(bytes: string): Blob {
  return new Blob([bytes], { type: 'image/png' });
}

describe('addMedia', () => {
  it('stores a blob and returns it back', async () => {
    const item = await addMedia(png('a'), 'shot.png');
    expect(item.filename).toBe('shot.png');
    expect(item.mime).toBe('image/png');
    expect(await db.media.get(item.id)).toEqual(item);
  });

  it('dedupes identical bytes rather than storing them twice', async () => {
    const first = await addMedia(png('same bytes'), 'a.png');
    const second = await addMedia(png('same bytes'), 'b.png');
    expect(second.id).toBe(first.id);
    expect(await db.media.count()).toBe(1);
  });

  it('stores different bytes separately even with the same filename', async () => {
    const first = await addMedia(png('one'), 'shot.png');
    const second = await addMedia(png('two'), 'shot.png');
    expect(second.id).not.toBe(first.id);
    expect(await db.media.count()).toBe(2);
  });
});

describe('referencedMediaIds', () => {
  it('counts a reference in cloze text', async () => {
    const item = await addMedia(png('x'), 'x.png');
    await createNote({ deckId, text: `{{c1::x}} ![x](media:${item.id})` });
    expect(await referencedMediaIds()).toEqual(new Set([item.id]));
  });

  it('counts a reference in extra, on either note type', async () => {
    const item = await addMedia(png('x'), 'x.png');
    await createNote({ deckId, text: '{{c1::x}}', extra: `![x](media:${item.id})` });
    expect(await referencedMediaIds()).toEqual(new Set([item.id]));
  });

  // The bug this phase fixed: a basic note's *back* field used to be left out
  // of the scan, so its media looked orphaned and was a candidate for
  // deletion despite still being shown on the card.
  it('counts a reference in a basic note’s back field', async () => {
    const item = await addMedia(png('x'), 'x.png');
    await createNote({ deckId, type: 'basic', text: 'Front', back: `![x](media:${item.id})` });
    expect(await referencedMediaIds()).toEqual(new Set([item.id]));
  });

  it('ignores a reference on a soft-deleted note', async () => {
    const item = await addMedia(png('x'), 'x.png');
    const { note } = await createNote({ deckId, text: `{{c1::x}} ![x](media:${item.id})` });
    await deleteNote(note.id);
    expect(await referencedMediaIds()).toEqual(new Set());
  });

  it('collects references from more than one note', async () => {
    const a = await addMedia(png('a'), 'a.png');
    const b = await addMedia(png('b'), 'b.png');
    await createNote({ deckId, text: `{{c1::x}} ![a](media:${a.id})` });
    await createNote({ deckId, type: 'basic', text: 'Front', back: `![b](media:${b.id})` });
    expect(await referencedMediaIds()).toEqual(new Set([a.id, b.id]));
  });
});

describe('auditMedia', () => {
  it('separates orphans (stored, unreferenced) from live media', async () => {
    const used = await addMedia(png('used'), 'used.png');
    const orphan = await addMedia(png('orphan'), 'orphan.png');
    await createNote({ deckId, text: `{{c1::x}} ![u](media:${used.id})` });

    const audit = await auditMedia();
    expect(audit.totalCount).toBe(2);
    expect(audit.orphans.map((m) => m.id)).toEqual([orphan.id]);
    expect(audit.dangling).toEqual([]);
    expect(audit.totalBytes).toBe(used.size + orphan.size);
  });

  it('a basic note’s back-field media is never reported as an orphan', async () => {
    const item = await addMedia(png('back media'), 'x.png');
    await createNote({ deckId, type: 'basic', text: 'Front', back: `![x](media:${item.id})` });

    const audit = await auditMedia();
    expect(audit.orphans).toEqual([]);
  });

  it('reports a dangling reference to media that was never stored', async () => {
    await createNote({ deckId, text: '{{c1::x}} ![gone](media:11111111-1111-1111-1111-111111111111)' });
    const audit = await auditMedia();
    expect(audit.dangling).toEqual(['11111111-1111-1111-1111-111111111111']);
  });
});

describe('deleteMedia', () => {
  it('removes the stored blob', async () => {
    const item = await addMedia(png('x'), 'x.png');
    await deleteMedia([item.id]);
    expect(await db.media.get(item.id)).toBeUndefined();
  });
});

describe('object URL cache', () => {
  it('returns null for a media id that does not exist', async () => {
    expect(await acquireObjectUrl('no-such-id')).toBeNull();
  });

  it('shares one URL across concurrent acquires and reports the mime type', async () => {
    const item = await addMedia(png('x'), 'x.png');
    const first = await acquireObjectUrl(item.id);
    const second = await acquireObjectUrl(item.id);
    expect(first).not.toBeNull();
    expect(first?.url).toBe(second?.url);
    expect(first?.mime).toBe('image/png');
    releaseObjectUrl(item.id);
    releaseObjectUrl(item.id);
  });

  it('a fresh acquire after a full release still resolves', async () => {
    const item = await addMedia(png('x'), 'x.png');
    const first = await acquireObjectUrl(item.id);
    releaseObjectUrl(item.id);
    const second = await acquireObjectUrl(item.id);
    expect(second).not.toBeNull();
    expect(second?.mime).toBe(first?.mime);
    releaseObjectUrl(item.id);
  });
});
