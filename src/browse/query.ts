/**
 * The browse search language.
 *
 * A deliberately small subset of Anki's: enough that someone coming from Anki
 * types what they already know, small enough to parse by hand and explain in
 * one tooltip. Every clause is AND-ed; there is no OR and no grouping.
 *
 *   word            the word appears anywhere in the note (front, back, extra)
 *   "two words"     the exact phrase
 *   -word           negate any clause, including the filters below
 *   net*            `*` is a wildcard: within one word in text, anything in filters
 *   tag:name        has that tag (`tag:none` — has no tags at all)
 *   deck:name       in that deck; quote names with spaces: deck:"Active Directory"
 *   type:basic      or type:cloze
 *   is:due          has a card due today (also new, learning, review,
 *                   suspended, and `empty` — generates no cards)
 *   added:7         created within the last 7 study days (edited:7 likewise)
 *
 * Parsing never throws. Anything it can't use becomes a warning and the rest
 * of the query still runs, because a search box that errors on a half-typed
 * `tag:` is a search box people stop trusting.
 */

import type { NoteType } from '../notetypes';

export type CardFlag = 'new' | 'learning' | 'review' | 'suspended' | 'due' | 'empty';
const CARD_FLAGS: readonly CardFlag[] = ['new', 'learning', 'review', 'suspended', 'due', 'empty'];

export type Clause =
  | { kind: 'text'; pattern: string; negate: boolean }
  | { kind: 'tag'; pattern: string; negate: boolean }
  | { kind: 'untagged'; negate: boolean }
  | { kind: 'deck'; pattern: string; negate: boolean }
  | { kind: 'type'; value: NoteType; negate: boolean }
  | { kind: 'is'; value: CardFlag; negate: boolean }
  | { kind: 'added' | 'edited'; days: number; negate: boolean };

export interface ParsedQuery {
  clauses: Clause[];
  warnings: string[];
}

interface Token {
  negate: boolean;
  /** Lowercased field name when the token was `field:value` with the colon outside quotes. */
  field: string | null;
  value: string;
  /** The token as typed, minus a leading `-`, for falling back to a text search. */
  raw: string;
}

/**
 * Split on whitespace outside quotes. Quotes are removed from the value but
 * remembered positionally: a colon only makes a field if it comes before the
 * first quote, so `"tag:foo"` searches for the literal text `tag:foo`.
 */
function tokenize(input: string, warnings: string[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    let negate = false;
    if (input[i] === '-' && i + 1 < input.length && !/\s/.test(input[i + 1])) {
      negate = true;
      i++;
    }

    const start = i;
    let value = '';
    let field: string | null = null;
    let quoted = false;
    let sawQuote = false;

    while (i < input.length && (quoted || !/\s/.test(input[i]))) {
      const c = input[i];
      if (c === '"') {
        quoted = !quoted;
        sawQuote = true;
      } else if (c === ':' && !quoted && !sawQuote && field === null && /^[a-z]+$/i.test(value)) {
        field = value.toLowerCase();
        value = '';
      } else {
        value += c;
      }
      i++;
    }
    if (quoted) warnings.push('Unclosed quote — treated as running to the end of the search.');

    tokens.push({ negate, field, value, raw: input.slice(start, i).replace(/"/g, '') });
  }

  return tokens;
}

const KNOWN_FIELDS = new Set(['tag', 'deck', 'type', 'is', 'added', 'edited']);

export function parseQuery(input: string): ParsedQuery {
  const warnings: string[] = [];
  const clauses: Clause[] = [];

  for (const token of tokenize(input, warnings)) {
    const { negate, field } = token;
    const value = token.value.trim();

    if (field === null || !KNOWN_FIELDS.has(field)) {
      // A single-letter prefix is far more likely to be `C:\Windows` than a
      // mistyped filter, so only warn for word-like ones.
      if (field !== null && field.length > 1) {
        warnings.push(`Unknown filter "${field}:" — searching for it as text.`);
      }
      const pattern = field === null ? value : token.raw;
      if (pattern) clauses.push({ kind: 'text', pattern, negate });
      continue;
    }

    if (!value) {
      warnings.push(`"${field}:" needs a value.`);
      continue;
    }

    switch (field) {
      case 'tag':
        clauses.push(
          value.toLowerCase() === 'none'
            ? { kind: 'untagged', negate }
            : { kind: 'tag', pattern: value, negate },
        );
        break;

      case 'deck':
        clauses.push({ kind: 'deck', pattern: value, negate });
        break;

      case 'type': {
        const t = value.toLowerCase();
        if (t === 'cloze' || t === 'basic') clauses.push({ kind: 'type', value: t, negate });
        else warnings.push(`type: is cloze or basic, not "${value}".`);
        break;
      }

      case 'is': {
        const flag = value.toLowerCase() as CardFlag;
        if (CARD_FLAGS.includes(flag)) clauses.push({ kind: 'is', value: flag, negate });
        else warnings.push(`is: takes ${CARD_FLAGS.join(', ')} — not "${value}".`);
        break;
      }

      case 'added':
      case 'edited': {
        const days = Number(value);
        if (Number.isInteger(days) && days > 0) clauses.push({ kind: field, days, negate });
        else warnings.push(`${field}: takes a whole number of days, like ${field}:7.`);
        break;
      }
    }
  }

  return { clauses, warnings };
}

// ---------------------------------------------------------------------------
// Matching primitives
// ---------------------------------------------------------------------------

/**
 * Case- and accent-insensitive form, so `cafe` finds `Café`. Both sides of
 * every comparison go through this.
 */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A `*` glob as a regex over folded text. `anchored` for whole-value matches
 * (tags, deck names); unanchored for text, where the term may sit anywhere.
 *
 * In text, `*` stays inside one word: `net*` should find "network", not every
 * note where "net" appears somewhere before some later letter. Deck names have
 * spaces in them, so there it matches anything.
 */
export function globRegex(pattern: string, anchored: boolean): RegExp {
  const star = anchored ? '[\\s\\S]*' : '\\S*';
  const body = fold(pattern).split('*').map(escapeRegex).join(star);
  return new RegExp(anchored ? `^${body}$` : body);
}

/** Add a clause to a query string, quoting the value when it needs it. */
export function withFilter(query: string, field: string, value: string): string {
  const v = /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
  const clause = `${field}:${v}`;
  const trimmed = query.trim();
  // Don't stack the same filter twice when a chip is clicked again.
  if (new RegExp(`(^|\\s)${escapeRegex(clause)}(\\s|$)`).test(trimmed)) return trimmed;
  return trimmed ? `${trimmed} ${clause}` : clause;
}
