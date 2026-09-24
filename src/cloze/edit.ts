/**
 * Editing helpers.
 *
 * Pure string transforms for the note editor's cloze commands, kept separate
 * from parsing and rendering so the editor (phase 3) is mostly wiring.
 */

import { nextOrdinal, parseCloze } from './parse';

export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Escape a run of text so it means itself inside a cloze body.
 *
 * Two rules, both narrow on purpose:
 *
 *  - `::` becomes `\:\:`, because an unescaped `::` starts a hint. Wrapping
 *    `[Net.WebClient]::DownloadString` must not quietly turn the method name
 *    into a hint that gives the answer away.
 *  - A backslash is doubled only when it precedes a character the parser would
 *    treat as escaped, so `\frac` and `C:\Windows` survive untouched.
 *
 * Braces are left alone when they balance — `\frac{1}{2}` parses correctly as
 * written, and escaping it would make the source unreadable for no gain. Only
 * an unbalanced selection gets its braces escaped, since that is the case the
 * parser genuinely cannot delimit.
 */
export function escapeClozeBody(s: string): string {
  const escapeBraces = bracesAreUnbalanced(s);
  let out = '';

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && ':{}\\'.includes(s[i + 1])) {
      out += '\\\\';
      continue;
    }
    if (c === ':' && s[i + 1] === ':') {
      out += '\\:\\:';
      i++;
      continue;
    }
    if (escapeBraces && (c === '{' || c === '}')) {
      out += `\\${c}`;
      continue;
    }
    out += c;
  }

  return out;
}

function bracesAreUnbalanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

/**
 * Wrap a selection in cloze markup — the editor's Ctrl+Shift+C.
 *
 * `ordinal` defaults to the next unused number, which is what the plain
 * shortcut does. Passing the current maximum instead implements
 * Ctrl+Shift+Alt+C: adding another deletion to the *same* card.
 *
 * With an empty selection this inserts an empty deletion and puts the caret
 * inside it, ready to type.
 */
export function wrapAsCloze(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  ordinal?: number,
): EditResult {
  const n = ordinal ?? nextOrdinal(text);
  const selected = text.slice(selectionStart, selectionEnd);
  const body = escapeClozeBody(selected);
  const open = `{{c${n}::`;

  const caret = selectionStart + open.length;
  return {
    text: `${text.slice(0, selectionStart)}${open}${body}}}${text.slice(selectionEnd)}`,
    selectionStart: caret,
    selectionEnd: caret + body.length,
  };
}

/**
 * The highest ordinal in use, or 0. `wrapAsCloze(text, a, b, sameOrdinal(text))`
 * adds a deletion to the most recent card rather than creating a new one.
 */
export function sameOrdinal(text: string): number {
  const used = parseCloze(text).ordinals;
  return used.length ? used[used.length - 1] : 1;
}

/**
 * Renumber deletions to close gaps: c1, c3, c7 becomes c1, c2, c3.
 *
 * Offered as an explicit editor command, never run automatically. Renumbering
 * retires the cards for the vacated ordinals and their review history along
 * with them, which is a choice the author should make deliberately.
 */
export function renumberOrdinals(text: string): string {
  const parsed = parseCloze(text);
  if (parsed.ordinals.length === 0) return text;

  const mapping = new Map<number, number>();
  parsed.ordinals.forEach((old, index) => mapping.set(old, index + 1));

  // Rebuild right to left so earlier offsets stay valid.
  let out = text;
  for (let i = parsed.nodes.length - 1; i >= 0; i--) {
    const node = parsed.nodes[i];
    if (node.kind !== 'cloze') continue;
    const next = mapping.get(node.ordinal);
    if (next === undefined || next === node.ordinal) continue;

    const head = `{{c${node.ordinal}::`;
    const replacement = `{{c${next}::`;
    out = out.slice(0, node.start) + replacement + out.slice(node.start + head.length);
  }

  return out;
}
