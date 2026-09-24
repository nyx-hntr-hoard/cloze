/**
 * CSV parsing.
 *
 * A hand-rolled character scanner rather than a regex split, for the same
 * reason the cloze parser is one: a quoted field can contain the delimiter, a
 * newline, or a doubled quote, and a regex that gets all of that right is
 * unreadable and still wrong at the edges. This follows RFC 4180 with the
 * relaxations real spreadsheets rely on — a bare LF as well as CRLF, and a
 * final row with no trailing newline at all.
 *
 * Quoting is only honored at the *start* of a field. A stray `"` after other
 * characters (`3" screen`) is common in real exports and is kept literal
 * rather than toggling into quote mode, which is what every spreadsheet
 * program's lenient reader does too.
 */

export function parseCsv(input: string): string[][] {
  // Strip a UTF-8 BOM: Excel writes one on export and expects one back on
  // import, so a round trip through this parser has to tolerate it.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function endField() {
    row.push(field);
    field = '';
  }
  function endRow() {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
      continue;
    }

    if (c === '"' && field === '') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\r') {
      // A lone CR and a CRLF pair both end the row; either way the LF (if
      // present) is consumed as part of the same terminator.
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (c === '\n') {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }

  // A trailing newline leaves nothing to flush. Anything else — including a
  // completely empty file, which has no field and no row yet — becomes one
  // final row.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}
