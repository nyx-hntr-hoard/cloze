/**
 * Column mapping.
 *
 * An arbitrary CSV has arbitrary headers — "Acronym" and "Definition" are
 * never going to auto-map to front and back — so importing one is a
 * three-step conversation: pick the note type for the whole file (Anki's CSV
 * importer works the same way, and mixing types per row would multiply the
 * UI for a case bulk import rarely needs), tell us what each column means,
 * and see the result on real rows before committing. `guessMapping` only
 * saves a few clicks for the common header names; nothing here requires it to
 * guess right.
 */

import type { NoteType } from '../notetypes';

export type ColumnField = 'text' | 'back' | 'reverse' | 'extra' | 'tags' | 'ignore';

export interface FieldOption {
  field: ColumnField;
  label: string;
}

const IGNORE: FieldOption = { field: 'ignore', label: 'Ignore this column' };

const CLOZE_FIELDS: FieldOption[] = [
  IGNORE,
  { field: 'text', label: 'Text (with {{c1::…}} markup)' },
  { field: 'extra', label: 'Extra' },
  { field: 'tags', label: 'Tags' },
];

const BASIC_FIELDS: FieldOption[] = [
  IGNORE,
  { field: 'text', label: 'Front' },
  { field: 'back', label: 'Back' },
  { field: 'extra', label: 'Extra' },
  { field: 'tags', label: 'Tags' },
  { field: 'reverse', label: 'Reverse? (per row)' },
];

/** Which fields a column can be assigned to, for the chosen note type. */
export function fieldsFor(type: NoteType): FieldOption[] {
  return type === 'basic' ? BASIC_FIELDS : CLOZE_FIELDS;
}

const HEADER_HINTS: Record<string, ColumnField> = {
  front: 'text',
  text: 'text',
  question: 'text',
  term: 'text',
  acronym: 'text',
  cloze: 'text',
  prompt: 'text',
  back: 'back',
  answer: 'back',
  definition: 'back',
  meaning: 'back',
  extra: 'extra',
  notes: 'extra',
  note: 'extra',
  context: 'extra',
  tags: 'tags',
  tag: 'tags',
  reverse: 'reverse',
  bidirectional: 'reverse',
};

/**
 * A best-effort mapping from header text, for the type currently selected.
 * Never assigns the same field to two columns — the first match wins — so
 * the caller does not have to police that itself.
 */
export function guessMapping(headers: string[], type: NoteType): ColumnField[] {
  const allowed = new Set(fieldsFor(type).map((f) => f.field));
  const used = new Set<ColumnField>();

  return headers.map((raw) => {
    const guess = HEADER_HINTS[raw.trim().toLowerCase()];
    if (guess && allowed.has(guess) && !used.has(guess)) {
      used.add(guess);
      return guess;
    }
    return 'ignore';
  });
}

// ---------------------------------------------------------------------------
// Applying a mapping to rows
// ---------------------------------------------------------------------------

export interface MappedRow {
  /** 0-based position within the data rows (header, if any, excluded). */
  index: number;
  text: string;
  back: string;
  extra: string;
  tags: string[];
  reverse: boolean;
  /** True when a required field is empty — this row cannot become a note. */
  blank: boolean;
}

export interface MapOptions {
  type: NoteType;
  /** One entry per CSV column, parallel to the row arrays. */
  mapping: ColumnField[];
  /** Basic only: applied when no column is mapped to `reverse`. */
  defaultReverse: boolean;
}

const TAG_SPLIT = /[,;\s]+/;
const FALSY = new Set(['', '0', 'false', 'no', 'n']);

function truthy(raw: string): boolean {
  return !FALSY.has(raw.trim().toLowerCase());
}

/** The value of the first column mapped to `field`, or `''` if none is. */
function valueFor(row: string[], mapping: ColumnField[], field: ColumnField): string {
  const i = mapping.indexOf(field);
  return i === -1 ? '' : (row[i] ?? '').trim();
}

export function mapRow(row: string[], index: number, options: MapOptions): MappedRow {
  const { type, mapping, defaultReverse } = options;

  const text = valueFor(row, mapping, 'text');
  const back = type === 'basic' ? valueFor(row, mapping, 'back') : '';
  const extra = valueFor(row, mapping, 'extra');
  const tagsRaw = valueFor(row, mapping, 'tags');
  const tags = tagsRaw ? tagsRaw.split(TAG_SPLIT).filter(Boolean) : [];

  const reverseCol = mapping.indexOf('reverse');
  const reverse =
    type === 'basic' ? (reverseCol === -1 ? defaultReverse : truthy(row[reverseCol] ?? '')) : false;

  const blank = type === 'basic' ? text === '' || back === '' : text === '';

  return { index, text, back, extra, tags, reverse, blank };
}

export function mapRows(rows: string[][], options: MapOptions): MappedRow[] {
  return rows.map((row, i) => mapRow(row, i, options));
}
