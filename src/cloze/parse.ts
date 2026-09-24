/**
 * Cloze parser.
 *
 * Grammar
 * -------
 *   {{cN::answer}}
 *   {{cN::answer::hint}}
 *
 * N is 1-based. The same ordinal may appear several times in one note; every
 * instance blanks together on that ordinal's card.
 *
 * Why a tokenizer and not a regex
 * -------------------------------
 * The obvious `/\{\{c(\d+)::(.*?)\}\}/` breaks on braces inside the answer,
 * which is not an exotic case — any LaTeX is enough. In `{{c1::\frac{1}{2}}}`
 * the first `}}` a regex finds is the tail of `{2}}`, so it closes the cloze in
 * the wrong place and silently produces a mangled card. This scanner tracks
 * brace depth and only closes on a `}}` that sits at the depth the opening `{{`
 * established.
 *
 * The `::` ambiguity
 * ------------------
 * `{{c1::[Net.WebClient]::DownloadString}}` is ambiguous: is `DownloadString` a
 * hint, or is `::` part of the answer? We follow Anki's rule — the first
 * unescaped `::` inside the body starts the hint, and everything after it is
 * hint, `::` included. That keeps decks interchangeable and muscle memory
 * intact.
 *
 * For text that genuinely contains `::` — C++ and PowerShell qualifiers, IPv6
 * addresses — escape it: `{{c1::[Net.WebClient]\:\:DownloadString}}`. The
 * escape sequences are `\:` `\{` `\}` and `\\`; `escapeCloze()` below applies
 * them, and the editor's wrap command uses it so a selection containing `::`
 * escapes itself.
 *
 * Nesting is rejected rather than guessed at, as it is in Anki. A nested cloze
 * emits an error and the whole span is treated as literal text, so the author
 * sees the problem in the preview instead of receiving a strange card.
 */

import type { ClozeNode, Diagnostic, Node, ParseResult, TextNode } from './types';

/** Characters that may follow a backslash to produce a literal. */
const ESCAPABLE = new Set([':', '{', '}', '\\']);

/** Matches the opening of a cloze at a given offset. */
const OPEN = /\{\{c(\d+)::/y;

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Resolve `\:` `\{` `\}` `\\` to their literals. Other backslashes stay. */
export function unescapeCloze(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Escape text so it survives being placed inside a cloze body verbatim.
 * Used by the editor when wrapping a selection, so that selecting
 * `[Net.WebClient]::DownloadString` and pressing the cloze shortcut does not
 * silently turn half of it into a hint.
 */
export function escapeCloze(s: string): string {
  return s.replace(/[\\:{}]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** True if an unescaped cloze opening starts at `i`. */
function clozeOpensAt(src: string, i: number): RegExpExecArray | null {
  OPEN.lastIndex = i;
  return OPEN.exec(src);
}

/**
 * Split a cloze body into answer and hint at the first unescaped `::`.
 * Returns raw (still-escaped) halves.
 */
function splitBody(body: string): { answer: string; hint?: string } {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length && ESCAPABLE.has(body[i + 1])) {
      i++;
      continue;
    }
    if (body[i] === ':' && body[i + 1] === ':') {
      return { answer: body.slice(0, i), hint: body.slice(i + 2) };
    }
  }
  return { answer: body };
}

/**
 * Report brace trouble inside a body: a `}` that closes more than was opened,
 * or an unclosed `{`. The extent was already resolved by depth tracking, so
 * this is advisory — it tells the author to escape their braces.
 */
function bodyBracesAreUnbalanced(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length && ESCAPABLE.has(body[i + 1])) {
      i++;
      continue;
    }
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

interface ScanResult {
  /** Index just past the closing `}}`, or -1 if never closed. */
  end: number;
  /** Body text between `::` and the closing `}}`, still escaped. */
  body: string;
  /** Offset of a nested cloze opening, or -1. */
  nestedAt: number;
  /**
   * Why the scan failed, when it did. `eof` means the `}}` never arrived;
   * `underflow` means a stray `}` closed past the opening, so the extent is
   * ambiguous. The two deserve different advice.
   */
  failure?: 'eof' | 'underflow';
}

/**
 * Walk forward from the start of a cloze body to its matching `}}`.
 *
 * Depth starts at 2 — the two braces of the opening `{{`. A `}` only closes the
 * cloze when it sits at depth 2 and is immediately followed by another `}`;
 * otherwise it just decrements. That is what keeps `\frac{1}{2}` intact.
 */
function scanBody(src: string, bodyStart: number): ScanResult {
  let depth = 2;
  let nestedAt = -1;

  for (let i = bodyStart; i < src.length; i++) {
    const c = src[i];

    if (c === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      i++;
      continue;
    }

    if (c === '{') {
      if (nestedAt === -1 && clozeOpensAt(src, i)) nestedAt = i;
      depth++;
      continue;
    }

    if (c === '}') {
      if (depth === 2 && src[i + 1] === '}') {
        return { end: i + 2, body: src.slice(bodyStart, i), nestedAt };
      }
      depth--;
      if (depth <= 0) {
        // More closes than opens: the cloze can't be delimited sensibly.
        return { end: -1, body: src.slice(bodyStart, i), nestedAt, failure: 'underflow' };
      }
    }
  }

  return { end: -1, body: src.slice(bodyStart), nestedAt, failure: 'eof' };
}

/**
 * Parse note text into a list of text and cloze nodes plus any diagnostics.
 *
 * Always returns a usable AST. Malformed markup degrades to literal text rather
 * than throwing — a half-typed edit must still render a preview.
 */
export function parseCloze(src: string): ParseResult {
  const nodes: Node[] = [];
  const diagnostics: Diagnostic[] = [];
  const ordinals = new Set<number>();

  /** Start of the text run currently being accumulated. */
  let runStart = 0;

  const flushText = (until: number) => {
    if (until <= runStart) return;
    const raw = src.slice(runStart, until);
    const node: TextNode = {
      kind: 'text',
      text: unescapeCloze(raw),
      start: runStart,
      end: until,
    };
    nodes.push(node);
  };

  let i = 0;
  while (i < src.length) {
    // Escaped character: never the start of markup.
    if (src[i] === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      i += 2;
      continue;
    }

    const open = src[i] === '{' ? clozeOpensAt(src, i) : null;
    if (!open) {
      i++;
      continue;
    }

    const ordinal = Number.parseInt(open[1], 10);
    const bodyStart = i + open[0].length;
    const scan = scanBody(src, bodyStart);

    // --- never closed cleanly -------------------------------------------
    if (scan.end === -1) {
      diagnostics.push(
        scan.failure === 'underflow'
          ? {
              severity: 'error',
              code: 'unbalanced-braces',
              message: `A stray } closes {{c${ordinal}::…}} early. Escape literal braces as \\{ and \\}.`,
              start: i,
              end: src.length,
            }
          : {
              severity: 'error',
              code: 'unclosed-cloze',
              message: `This {{c${ordinal}::…}} is never closed. Add }} to finish it.`,
              start: i,
              end: src.length,
            },
      );
      // Everything from here on stays literal text.
      i = src.length;
      break;
    }

    // --- nested ---------------------------------------------------------
    if (scan.nestedAt !== -1) {
      diagnostics.push({
        severity: 'error',
        code: 'nested-cloze',
        message:
          'Cloze deletions cannot be nested. Split this into separate deletions on the same note.',
        start: i,
        end: scan.end,
      });
      i = scan.end; // Leave the span in the current text run.
      continue;
    }

    // --- ordinal 0 ------------------------------------------------------
    if (ordinal < 1) {
      diagnostics.push({
        severity: 'warning',
        code: 'invalid-ordinal',
        message: 'Cloze numbering starts at c1, so {{c0::…}} generates no card.',
        start: i,
        end: scan.end,
      });
      i = scan.end;
      continue;
    }

    // --- a real cloze ---------------------------------------------------
    flushText(i);

    const { answer: rawAnswer, hint: rawHint } = splitBody(scan.body);
    const answer = unescapeCloze(rawAnswer);
    const hint = rawHint === undefined ? undefined : unescapeCloze(rawHint);

    if (bodyBracesAreUnbalanced(scan.body)) {
      diagnostics.push({
        severity: 'warning',
        code: 'unbalanced-braces',
        message: 'Braces inside this deletion do not balance. Escape them as \\{ and \\}.',
        start: i,
        end: scan.end,
      });
    }

    if (answer.trim() === '') {
      diagnostics.push({
        severity: 'warning',
        code: 'empty-answer',
        message: `c${ordinal} has no answer text, so its card asks nothing.`,
        start: i,
        end: scan.end,
      });
    }

    const node: ClozeNode = {
      kind: 'cloze',
      ordinal,
      answer,
      start: i,
      end: scan.end,
    };
    if (hint !== undefined) node.hint = hint;
    nodes.push(node);

    ordinals.add(ordinal);
    i = scan.end;
    runStart = i;
  }

  flushText(src.length);

  const sorted = [...ordinals].sort((a, b) => a - b);
  // Only worth saying when nothing else already explains the absence — an
  // unclosed or nested deletion has its own, more useful message.
  const alreadyExplained = diagnostics.some((d) => d.severity === 'error');
  if (sorted.length === 0 && src.trim() !== '' && !alreadyExplained) {
    diagnostics.push({
      severity: 'warning',
      code: 'no-cloze',
      message: 'No cloze deletions here, so this note generates no cards.',
      start: 0,
      end: src.length,
    });
  }

  return { nodes, diagnostics, ordinals: sorted };
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * The distinct ordinals in a note — one card per entry.
 *
 * This is what the note repository calls to drive card reconciliation, so it
 * has to be total: any string, however broken, yields a defined answer.
 */
export function clozeOrdinals(src: string): number[] {
  return parseCloze(src).ordinals;
}

/**
 * The next unused ordinal, for the editor's "add deletion" command.
 * Fills gaps rather than always appending, so deleting c2 of three and adding
 * a new one reuses 2 instead of creating 4.
 */
export function nextOrdinal(src: string): number {
  const used = new Set(parseCloze(src).ordinals);
  for (let n = 1; ; n++) if (!used.has(n)) return n;
}

export interface ClozeSummary {
  ordinals: number[];
  cardCount: number;
  diagnostics: Diagnostic[];
  /** True when something would produce a wrong card, not merely a poor one. */
  hasError: boolean;
}

/** One call for the editor's status line and save guard. */
export function summarize(src: string): ClozeSummary {
  const { ordinals, diagnostics } = parseCloze(src);
  return {
    ordinals,
    cardCount: ordinals.length,
    diagnostics,
    hasError: diagnostics.some((d) => d.severity === 'error'),
  };
}
