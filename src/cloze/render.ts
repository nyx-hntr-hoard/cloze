/**
 * Card rendering.
 *
 * Turns a parsed note plus a target ordinal into the segment list a review
 * screen draws. Segments rather than HTML: the renderer stays pure and
 * testable, and the review UI decides how a blank or a revealed answer looks.
 *
 * On the card for `c1`, every `{{c1::…}}` in the note is blanked — including
 * repeats — and every other deletion shows its answer as ordinary context. That
 * is Anki's behaviour and it is what makes multi-deletion notes read as
 * sentences rather than as a row of holes.
 */

import type {
  ClozeNode,
  MediaSegment,
  ParseResult,
  RenderedCard,
  Segment,
  TextSegment,
} from './types';
import { parseCloze } from './parse';

/** `![alt](media:<uuid>)` — the reference form stored inside note text. */
const MEDIA_REF = /!\[([^\]]*)\]\(media:([0-9a-fA-F-]{36})\)/g;

/**
 * Split literal text into text and media segments.
 *
 * Media inside a *cloze answer* is deliberately not expanded: an answer renders
 * as one styled unit, and an image that is itself the hidden answer is not a
 * case worth the complexity. Such a reference stays visible as its markup,
 * which is at least honest about what happened.
 */
export function splitMedia(text: string): (TextSegment | MediaSegment)[] {
  const out: (TextSegment | MediaSegment)[] = [];
  let last = 0;

  MEDIA_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_REF.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'media', alt: m[1], id: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });

  return out;
}

function pushText(into: Segment[], text: string): void {
  if (text === '') return;
  for (const seg of splitMedia(text)) into.push(seg);
}

/** The answer text of a non-target deletion, as plain context. */
function contextSegment(node: ClozeNode): Segment {
  return { kind: 'context', ordinal: node.ordinal, text: node.answer };
}

/**
 * Render one card from an already-parsed note.
 *
 * `front` and `back` differ only at the target deletions: blank on the front,
 * revealed on the back. Everything else is identical, so the card does not jump
 * when the answer is shown.
 */
export function renderCardFrom(parsed: ParseResult, ordinal: number): RenderedCard {
  const front: Segment[] = [];
  const back: Segment[] = [];

  for (const node of parsed.nodes) {
    if (node.kind === 'text') {
      pushText(front, node.text);
      pushText(back, node.text);
      continue;
    }

    if (node.ordinal === ordinal) {
      front.push(
        node.hint !== undefined && node.hint !== ''
          ? { kind: 'blank', ordinal, hint: node.hint }
          : { kind: 'blank', ordinal },
      );
      back.push({ kind: 'reveal', ordinal, text: node.answer });
    } else {
      front.push(contextSegment(node));
      back.push(contextSegment(node));
    }
  }

  return { ordinal, front, back };
}

/** Parse and render in one step. */
export function renderCard(src: string, ordinal: number): RenderedCard {
  return renderCardFrom(parseCloze(src), ordinal);
}

/** Every card a note generates, in ordinal order. Used by the editor preview. */
export function renderAllCards(src: string): RenderedCard[] {
  const parsed = parseCloze(src);
  return parsed.ordinals.map((n) => renderCardFrom(parsed, n));
}

/**
 * The note with every deletion shown — what a browse list or search result
 * displays. No blanks, no target.
 */
export function renderPlain(src: string): Segment[] {
  const parsed = parseCloze(src);
  const out: Segment[] = [];
  for (const node of parsed.nodes) {
    if (node.kind === 'text') pushText(out, node.text);
    else out.push(contextSegment(node));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain-text projections
// ---------------------------------------------------------------------------

/** Placeholder drawn for a blank when flattening to a string. */
const BLANK = '[…]';

/**
 * Flatten segments to a plain string. For list views, search indexing, CSV
 * export and test assertions — anywhere a single line beats a segment array.
 */
export function segmentsToText(segments: Segment[]): string {
  let out = '';
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        out += seg.text;
        break;
      case 'blank':
        out += seg.hint ? `[${seg.hint}]` : BLANK;
        break;
      case 'reveal':
      case 'context':
        out += seg.text;
        break;
      case 'media':
        out += seg.alt ? `[${seg.alt}]` : '[image]';
        break;
      case 'divider':
        out += '\n— \n';
        break;
    }
  }
  return out;
}

/**
 * A one-line summary of a note for browse lists: all deletions shown, media
 * collapsed, whitespace normalized.
 */
export function noteSummary(src: string, maxLength = 120): string {
  const text = segmentsToText(renderPlain(src)).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Every media id referenced by a note, in order of first appearance. */
export function mediaIdsIn(src: string): string[] {
  const ids: string[] = [];
  MEDIA_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_REF.exec(src)) !== null) {
    if (!ids.includes(m[2])) ids.push(m[2]);
  }
  return ids;
}
