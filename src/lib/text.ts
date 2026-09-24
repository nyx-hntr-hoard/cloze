/**
 * Small, general-purpose string helpers with no feature of their own —
 * pulled out so they can be unit-tested in isolation and reused verbatim.
 * Originally just the "download a file" helpers (a filesystem-safe name, a
 * sortable timestamp, a truncated preview); `spliceText`/`mediaMarkdown`
 * back the note editor's media attachment instead, but they're the same
 * kind of thing — plain string transforms with nothing feature-specific in
 * them.
 */

/** Filesystem-safe version of a name, for a download filename. */
export function slugify(name: string, fallback = 'export'): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 48) || fallback
  );
}

/** `YYYY-MM-DD-HHmm` (local time), for a download filename. */
export function stampFilename(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A single-line preview of a field: collapse whitespace, cut to length. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "1 note" / "2 notes" — every result banner needs this. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface SpliceResult {
  text: string;
  /** Where the caret lands — right after the inserted text. */
  caret: number;
}

/** Replace `text[start, end)` with `insert`, reporting where the caret goes next. */
export function spliceText(text: string, start: number, end: number, insert: string): SpliceResult {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/**
 * The `![alt](media:<id>)` reference the cloze/render engine looks for.
 *
 * `alt` is free text (a pasted screenshot's filename, typed by whoever named
 * it), so a stray `[` or `]` is stripped rather than escaped — the syntax has
 * no escape for it, and `renderNoteCard`'s `MEDIA_REF` would otherwise stop
 * matching partway through the reference and leave the rest as stray text on
 * the card.
 */
export function mediaMarkdown(id: string, alt: string): string {
  return `![${alt.replace(/[[\]]/g, '')}](media:${id})`;
}

/** A readable caption guess from a filename: drop the extension, spell out separators. */
export function altFromFilename(name: string): string {
  return name
    .replace(/\.[^./\\]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}
