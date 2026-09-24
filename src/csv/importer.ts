/**
 * CSV import: planning and committing.
 *
 * `planCsvImport` and `importCsv` share one row-classification pass
 * (`classify`) rather than each recomputing which rows are blank or
 * duplicates. Phase 4 learned this lesson the hard way — `buildQueue` and
 * `reinsert` disagreeing about the learn-ahead window was a real bug — so
 * here the preview and the commit are guaranteed to agree because they are
 * the same computation.
 *
 * Existing content hashes are loaded once per deck rather than queried per
 * row: a query per row is the kind of thing that is invisible at 20 rows and
 * unusable at 2,000.
 */

import { hashNoteText } from '../lib/id';
import { noteHashSource, type NoteType } from '../notetypes';
import { createNote, notesInDeck } from '../repo';
import type { MappedRow } from './mapping';

type RowVerdict = 'blank' | 'duplicate' | 'ok';

async function classify(
  deckId: string,
  type: NoteType,
  rows: MappedRow[],
  skipDuplicates: boolean,
): Promise<RowVerdict[]> {
  const existingHashes = skipDuplicates
    ? new Set((await notesInDeck(deckId)).map((n) => n.contentHash))
    : new Set<string>();
  const seenInFile = new Set<string>();

  return rows.map((row) => {
    if (row.blank) return 'blank';
    if (!skipDuplicates) return 'ok';

    const hash = hashNoteText(noteHashSource({ type, text: row.text, back: row.back }));
    if (seenInFile.has(hash) || existingHashes.has(hash)) return 'duplicate';
    seenInFile.add(hash);
    return 'ok';
  });
}

export interface CsvImportPlan {
  totalRows: number;
  /** Rows that would become notes. */
  toImport: number;
  /** Rows missing a required field. */
  blank: number;
  /** Rows skipped as duplicates, of an existing note or of an earlier row. */
  duplicates: number;
}

/** What an import would do, without writing anything. */
export async function planCsvImport(
  deckId: string,
  type: NoteType,
  rows: MappedRow[],
  skipDuplicates: boolean,
): Promise<CsvImportPlan> {
  const verdicts = await classify(deckId, type, rows, skipDuplicates);
  return {
    totalRows: rows.length,
    toImport: verdicts.filter((v) => v === 'ok').length,
    blank: verdicts.filter((v) => v === 'blank').length,
    duplicates: verdicts.filter((v) => v === 'duplicate').length,
  };
}

export interface CsvImportResult {
  notesImported: number;
  cardsImported: number;
  blankSkipped: number;
  duplicatesSkipped: number;
  /** Imported but generated zero cards — e.g. cloze text with no deletion. */
  noCards: number;
}

/**
 * Commit the rows that classify as importable.
 *
 * Each row goes through `createNote`, the same permissive path a single
 * hand-typed note takes: a row that parses to zero cards is still saved
 * (and counted in `noCards`) rather than aborting the rest of the file over
 * one bad row.
 */
export async function importCsv(
  deckId: string,
  type: NoteType,
  rows: MappedRow[],
  skipDuplicates: boolean,
): Promise<CsvImportResult> {
  const verdicts = await classify(deckId, type, rows, skipDuplicates);
  const result: CsvImportResult = {
    notesImported: 0,
    cardsImported: 0,
    blankSkipped: 0,
    duplicatesSkipped: 0,
    noCards: 0,
  };

  for (let i = 0; i < rows.length; i++) {
    const verdict = verdicts[i];
    if (verdict === 'blank') {
      result.blankSkipped++;
      continue;
    }
    if (verdict === 'duplicate') {
      result.duplicatesSkipped++;
      continue;
    }

    const row = rows[i];
    const { cards } = await createNote({
      deckId,
      type,
      text: row.text,
      back: type === 'basic' ? row.back : undefined,
      reverse: type === 'basic' ? row.reverse : undefined,
      extra: row.extra,
      tags: row.tags,
    });
    result.notesImported++;
    result.cardsImported += cards.length;
    if (cards.length === 0) result.noCards++;
  }

  return result;
}
