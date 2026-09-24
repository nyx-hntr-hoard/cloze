import { describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import type { Card, Deck, Note } from '../db/types';
import { DEFAULT_DECK_CONFIG } from '../db/types';
import { newCard } from '../repo/cards';
import { DAY } from '../lib/time';
import { fold, globRegex, parseQuery, withFilter } from './query';
import { filterEntries, indexNotes, nextDue, sortEntries, type Clock } from './search';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parseQuery', () => {
  it('parses bare words as AND-ed text clauses', () => {
    expect(parseQuery('kerberos  ticket').clauses).toEqual([
      { kind: 'text', pattern: 'kerberos', negate: false },
      { kind: 'text', pattern: 'ticket', negate: false },
    ]);
  });

  it('keeps a quoted phrase together', () => {
    expect(parseQuery('"service principal"').clauses).toEqual([
      { kind: 'text', pattern: 'service principal', negate: false },
    ]);
  });

  it('negates with a leading dash', () => {
    expect(parseQuery('-draft -tag:old').clauses).toEqual([
      { kind: 'text', pattern: 'draft', negate: true },
      { kind: 'tag', pattern: 'old', negate: true },
    ]);
  });

  it('treats a lone dash as text, not a negation of nothing', () => {
    expect(parseQuery('a - b').clauses.map((c) => c.kind === 'text' && c.pattern)).toEqual(['a', '-', 'b']);
  });

  it('accepts quoted filter values', () => {
    expect(parseQuery('deck:"Active Directory"').clauses).toEqual([
      { kind: 'deck', pattern: 'Active Directory', negate: false },
    ]);
  });

  it('a colon inside quotes is text, not a filter', () => {
    expect(parseQuery('"tag:foo"').clauses).toEqual([{ kind: 'text', pattern: 'tag:foo', negate: false }]);
  });

  it('field names are case-insensitive', () => {
    expect(parseQuery('TAG:x Is:Due TYPE:Basic').clauses).toEqual([
      { kind: 'tag', pattern: 'x', negate: false },
      { kind: 'is', value: 'due', negate: false },
      { kind: 'type', value: 'basic', negate: false },
    ]);
  });

  it('tag:none means untagged', () => {
    expect(parseQuery('tag:none').clauses).toEqual([{ kind: 'untagged', negate: false }]);
  });

  it('parses day counts', () => {
    expect(parseQuery('added:7 -edited:1').clauses).toEqual([
      { kind: 'added', days: 7, negate: false },
      { kind: 'edited', days: 1, negate: true },
    ]);
  });

  it('warns on bad values instead of throwing, and keeps the rest', () => {
    const q = parseQuery('is:bogus added:x type:fancy tag: real');
    expect(q.clauses).toEqual([{ kind: 'text', pattern: 'real', negate: false }]);
    expect(q.warnings).toHaveLength(4);
  });

  it('searches an unknown filter as text, with a warning', () => {
    const q = parseQuery('tga:foo');
    expect(q.clauses).toEqual([{ kind: 'text', pattern: 'tga:foo', negate: false }]);
    expect(q.warnings[0]).toMatch(/Unknown filter "tga:"/);
  });

  it('does not warn about drive letters and other one-letter prefixes', () => {
    const q = parseQuery('C:\\Windows');
    expect(q.clauses).toEqual([{ kind: 'text', pattern: 'C:\\Windows', negate: false }]);
    expect(q.warnings).toEqual([]);
  });

  it('warns about an unclosed quote but still searches', () => {
    const q = parseQuery('"half typed');
    expect(q.clauses).toEqual([{ kind: 'text', pattern: 'half typed', negate: false }]);
    expect(q.warnings).toHaveLength(1);
  });

  it('an empty query has no clauses', () => {
    expect(parseQuery('   ')).toEqual({ clauses: [], warnings: [] });
  });
});

describe('fold and globRegex', () => {
  it('folds case and accents', () => {
    expect(fold('Café MÉXICO')).toBe('cafe mexico');
  });

  it('anchored globs match whole values', () => {
    expect(globRegex('net*', true).test('network')).toBe(true);
    expect(globRegex('net*', true).test('subnet')).toBe(false);
    expect(globRegex('net', true).test('network')).toBe(false);
  });

  it('in text, * stays within a word', () => {
    expect(globRegex('net*', false).test('a network map')).toBe(true);
    expect(globRegex('n*k', false).test('net work')).toBe(false);
  });

  it('treats regex metacharacters literally', () => {
    expect(globRegex('c++', false).test('learn c++ now')).toBe(true);
    expect(globRegex('a.b', false).test('a.b')).toBe(true);
    expect(globRegex('a.b', false).test('axb')).toBe(false);
  });
});

describe('withFilter', () => {
  it('appends a filter, quoting when needed', () => {
    expect(withFilter('kerberos', 'deck', 'Active Directory')).toBe('kerberos deck:"Active Directory"');
    expect(withFilter('', 'tag', 'ad')).toBe('tag:ad');
  });

  it('does not add the same filter twice', () => {
    expect(withFilter('tag:ad x', 'tag', 'ad')).toBe('tag:ad x');
  });

  it('does not mistake a longer tag for the same one', () => {
    expect(withFilter('tag:adcs', 'tag', 'ad')).toBe('tag:adcs tag:ad');
  });
});

// ---------------------------------------------------------------------------
// Matching and sorting
// ---------------------------------------------------------------------------

const NOW = new Date(2026, 8, 23, 12, 0).getTime();
const clock: Clock = {
  todayStart: new Date(2026, 8, 23, 4, 0).getTime(),
  dueBy: new Date(2026, 8, 24, 4, 0).getTime(),
};

function deck(id: string, name: string): Deck {
  return { id, name, description: '', config: DEFAULT_DECK_CONFIG, created: 0, modified: 0 };
}

let seq = 0;
function note(partial: Partial<Note> & Pick<Note, 'text' | 'deckId'>): Note {
  seq++;
  return {
    id: `n${seq}`,
    extra: '',
    tags: [],
    contentHash: '',
    created: NOW,
    modified: NOW,
    ...partial,
  };
}

function card(n: Note, ordinal: number, patch: Partial<Card> = {}): Card {
  return { ...newCard(n.id, n.deckId, ordinal, NOW), ...patch };
}

const decks = [deck('d1', 'Active Directory'), deck('d2', 'Linux')];
const kerb = note({
  deckId: 'd1',
  text: 'A {{c1::TGT}} is issued by the {{c2::KDC}}',
  tags: ['kerberos', 'AD'],
});
const spn = note({ deckId: 'd1', type: 'basic', text: 'SPN', back: 'Service Principal Name', extra: 'Kerberoasting' });
const suid = note({
  deckId: 'd2',
  text: 'Find {{c1::SUID}} binaries',
  tags: ['privesc'],
  created: NOW - 10 * DAY,
  modified: NOW - 10 * DAY,
});
const empty = note({ deckId: 'd2', text: 'No deletions here yet' });
const cafe = note({ deckId: 'd2', text: 'Café {{c1::résumé}} ![network diagram](media:11111111-1111-1111-1111-111111111111)' });
const deleted = note({ deckId: 'd2', text: '{{c1::gone}}', deletedAt: NOW });

const cards: Card[] = [
  card(kerb, 1, { state: State.Review, reps: 3, due: NOW - DAY }),
  card(kerb, 2, { state: State.Review, reps: 3, due: NOW + 5 * DAY }),
  card(spn, 1, { state: State.Learning, reps: 1, due: NOW + 10 * 60_000 }),
  card(suid, 1, { suspended: true, state: State.Review, reps: 4, due: NOW - DAY }),
  card(cafe, 1),
  card(cafe, 2, { deletedAt: NOW }), // retired card — must be ignored
  card(deleted, 1),
];

const index = indexNotes({ notes: [kerb, spn, suid, empty, cafe, deleted], cards, decks });

function run(q: string): string[] {
  return filterEntries(index, parseQuery(q), clock).map((e) => e.note.id);
}

describe('indexNotes', () => {
  it('skips deleted notes and deleted cards', () => {
    expect(index.map((e) => e.note.id)).not.toContain(deleted.id);
    expect(index.find((e) => e.note.id === cafe.id)!.cards).toHaveLength(1);
  });

  it('indexes plain text, not markup', () => {
    const e = index.find((x) => x.note.id === kerb.id)!;
    expect(e.haystack).toContain('a tgt is issued by the kdc');
    expect(e.haystack).not.toContain('{{');
  });
});

describe('filterEntries', () => {
  it('empty query returns everything live', () => {
    expect(run('')).toHaveLength(5);
  });

  it('matches text across front, back and extra', () => {
    expect(run('principal')).toEqual([spn.id]);
    expect(run('kerberoasting')).toEqual([spn.id]);
  });

  it('does not match cloze markup itself', () => {
    expect(run('c1')).toEqual([]);
  });

  it('matches phrases, globs and accents', () => {
    expect(run('"issued by the"')).toEqual([kerb.id]);
    expect(run('bin*es')).toEqual([suid.id]);
    expect(run('resume')).toEqual([cafe.id]);
  });

  it('finds media by its alt text', () => {
    expect(run('diagram')).toEqual([cafe.id]);
  });

  it('negates', () => {
    expect(run('-deck:linux')).toEqual([kerb.id, spn.id]);
  });

  it('filters by tag, case-insensitively, with globs and tag:none', () => {
    expect(run('tag:ad')).toEqual([kerb.id]);
    expect(run('tag:kerb*')).toEqual([kerb.id]);
    expect(run('tag:none')).toEqual([spn.id, empty.id, cafe.id]);
  });

  it('filters by deck name', () => {
    expect(run('deck:"active directory"')).toEqual([kerb.id, spn.id]);
    expect(run('deck:act*')).toEqual([kerb.id, spn.id]);
  });

  it('filters by type', () => {
    expect(run('type:basic')).toEqual([spn.id]);
    expect(run('type:cloze')).toEqual([kerb.id, suid.id, empty.id, cafe.id]);
  });

  it('is: flags look at live cards', () => {
    expect(run('is:new')).toEqual([cafe.id]);
    expect(run('is:learning')).toEqual([spn.id]);
    expect(run('is:review')).toEqual([kerb.id, suid.id]);
    expect(run('is:suspended')).toEqual([suid.id]);
    expect(run('is:empty')).toEqual([empty.id]);
  });

  it('is:due means what the review screen would show today', () => {
    // kerb: overdue review card. spn: learning card due in 10 minutes.
    // suid: overdue but suspended. cafe: new — never "due".
    expect(run('is:due')).toEqual([kerb.id, spn.id]);
  });

  it('added:/edited: count study days', () => {
    expect(run('added:1')).toEqual([kerb.id, spn.id, empty.id, cafe.id]);
    expect(run('added:11')).toHaveLength(5);
    expect(run('-edited:7')).toEqual([suid.id]);
  });

  it('combines clauses with AND', () => {
    expect(run('deck:linux is:suspended tag:privesc')).toEqual([suid.id]);
    expect(run('deck:linux type:basic')).toEqual([]);
  });
});

describe('sorting', () => {
  it('sorts by deck name then newest edit', () => {
    const ids = sortEntries(index, 'deck', 'asc').map((e) => e.deckName);
    expect(ids).toEqual(['Active Directory', 'Active Directory', 'Linux', 'Linux', 'Linux']);
  });

  it('sorts by due with unscheduled notes last in both directions', () => {
    const asc = sortEntries(index, 'due', 'asc').map((e) => e.note.id);
    expect(asc.slice(0, 2)).toEqual([kerb.id, spn.id]);
    expect(asc.slice(2)).toEqual(expect.arrayContaining([suid.id, empty.id, cafe.id]));

    const desc = sortEntries(index, 'due', 'desc').map((e) => e.note.id);
    expect(desc.slice(0, 2)).toEqual([spn.id, kerb.id]);
  });

  it('nextDue ignores new and suspended cards', () => {
    const e = (id: string) => index.find((x) => x.note.id === id)!;
    expect(nextDue(e(kerb.id))).toBe(NOW - DAY);
    expect(nextDue(e(suid.id))).toBeNull();
    expect(nextDue(e(cafe.id))).toBeNull();
  });

  it('sorts by added date', () => {
    expect(sortEntries(index, 'added', 'asc')[0].note.id).toBe(suid.id);
  });
});
