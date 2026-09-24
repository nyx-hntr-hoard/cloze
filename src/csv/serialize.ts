/**
 * CSV serialization.
 *
 * The inverse of `parse.ts`: quote a field only when it must be quoted
 * (contains the delimiter, a quote, or a newline), and use CRLF between rows
 * because that is what spreadsheets write and expect back. A trailing CRLF
 * after the last row matches what real exports do and is exactly what
 * `parseCsv` treats as "no extra row" on the way back in.
 */

const NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeCsv(rows: string[][]): string {
  if (rows.length === 0) return '';
  return `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}
