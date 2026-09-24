import { describe, expect, it } from 'vitest';
import {
  mediaIdsIn,
  noteSummary,
  renderAllCards,
  renderCard,
  renderPlain,
  segmentsToText,
  splitMedia,
} from './render';

const front = (src: string, n: number) => segmentsToText(renderCard(src, n).front);
const back = (src: string, n: number) => segmentsToText(renderCard(src, n).back);

const MEDIA_A = '11111111-2222-4333-8444-555555555555';
const MEDIA_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Front and back
// ---------------------------------------------------------------------------

describe('rendering a card', () => {
  it('blanks the target and reveals it on the back', () => {
    const src = 'The capital is {{c1::Paris}}.';
    expect(front(src, 1)).toBe('The capital is […].');
    expect(back(src, 1)).toBe('The capital is Paris.');
  });

  it('shows a hint in place of the blank', () => {
    const src = 'The capital is {{c1::Paris::a city}}.';
    expect(front(src, 1)).toBe('The capital is [a city].');
    expect(back(src, 1)).toBe('The capital is Paris.');
  });

  it('shows other deletions as ordinary context', () => {
    const src = '{{c1::Kerberos}} uses {{c2::TGT}} tickets.';
    expect(front(src, 1)).toBe('[…] uses TGT tickets.');
    expect(front(src, 2)).toBe('Kerberos uses […] tickets.');
  });

  it('blanks every instance of the target ordinal together', () => {
    const src = '{{c1::SMB}} runs on 445; {{c1::SMB}} also uses 139.';
    expect(front(src, 1)).toBe('[…] runs on 445; […] also uses 139.');
    expect(back(src, 1)).toBe('SMB runs on 445; SMB also uses 139.');
  });

  it('keeps front and back structurally identical apart from the target', () => {
    const card = renderCard('a {{c1::b}} c {{c2::d}} e', 1);
    expect(card.front).toHaveLength(card.back.length);
    expect(card.front.map((s) => s.kind)).toEqual(['text', 'blank', 'text', 'context', 'text']);
    expect(card.back.map((s) => s.kind)).toEqual(['text', 'reveal', 'text', 'context', 'text']);
  });

  it('marks each segment with the ordinal it belongs to', () => {
    const card = renderCard('{{c1::a}} {{c2::b}}', 1);
    expect(card.front[0]).toEqual({ kind: 'blank', ordinal: 1 });
    expect(card.front[2]).toEqual({ kind: 'context', ordinal: 2, text: 'b' });
  });

  it('renders an ordinal that is not present as a card with no blank', () => {
    const card = renderCard('{{c1::a}}', 7);
    expect(card.front.every((s) => s.kind !== 'blank')).toBe(true);
  });

  it('renders an empty answer as an empty reveal, not a crash', () => {
    expect(front('x {{c1::}} y', 1)).toBe('x […] y');
    expect(back('x {{c1::}} y', 1)).toBe('x  y');
  });

  it('carries escaped content through to the rendered card', () => {
    const src = 'Call {{c1::[Net.WebClient]\\:\\:DownloadString}} to fetch.';
    expect(front(src, 1)).toBe('Call […] to fetch.');
    expect(back(src, 1)).toBe('Call [Net.WebClient]::DownloadString to fetch.');
  });
});

// ---------------------------------------------------------------------------
// All cards / plain
// ---------------------------------------------------------------------------

describe('renderAllCards', () => {
  it('returns one card per distinct ordinal, in order', () => {
    const cards = renderAllCards('{{c2::b}} {{c1::a}} {{c2::b again}}');
    expect(cards.map((c) => c.ordinal)).toEqual([1, 2]);
  });

  it('returns nothing for a note with no deletions', () => {
    expect(renderAllCards('plain text')).toEqual([]);
  });

  it('parses once for all cards', () => {
    // Behavioural proxy: the same note rendered as a set matches rendering each
    // ordinal individually.
    const src = '{{c1::a}} {{c2::b}} {{c3::c}}';
    const all = renderAllCards(src);
    for (const card of all) {
      expect(segmentsToText(card.front)).toBe(front(src, card.ordinal));
    }
  });
});

describe('renderPlain', () => {
  it('shows every answer with no blanks', () => {
    expect(segmentsToText(renderPlain('{{c1::a}} and {{c2::b}}'))).toBe('a and b');
  });

  it('drops hints, which are a front-of-card affordance', () => {
    expect(segmentsToText(renderPlain('{{c1::Paris::a city}}'))).toBe('Paris');
  });
});

describe('noteSummary', () => {
  it('collapses whitespace across lines', () => {
    expect(noteSummary('line one\n\n  {{c1::two}}   three')).toBe('line one two three');
  });

  it('truncates with an ellipsis', () => {
    expect(noteSummary('x'.repeat(200), 20)).toHaveLength(20);
    expect(noteSummary('x'.repeat(200), 20).endsWith('…')).toBe(true);
  });

  it('leaves a short note untouched', () => {
    expect(noteSummary('{{c1::short}}')).toBe('short');
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

describe('media references', () => {
  it('splits a media reference out of surrounding text', () => {
    expect(splitMedia(`before ![diagram](media:${MEDIA_A}) after`)).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'media', alt: 'diagram', id: MEDIA_A },
      { kind: 'text', text: ' after' },
    ]);
  });

  it('handles an empty alt', () => {
    expect(splitMedia(`![](media:${MEDIA_A})`)).toEqual([
      { kind: 'media', alt: '', id: MEDIA_A },
    ]);
  });

  it('handles several references in one run', () => {
    const segs = splitMedia(`![a](media:${MEDIA_A})![b](media:${MEDIA_B})`);
    expect(segs.map((s) => s.kind)).toEqual(['media', 'media']);
  });

  it('leaves text with no references as a single segment', () => {
    expect(splitMedia('nothing here')).toEqual([{ kind: 'text', text: 'nothing here' }]);
  });

  it('ignores a malformed reference', () => {
    expect(splitMedia('![a](media:not-a-uuid)')).toEqual([
      { kind: 'text', text: '![a](media:not-a-uuid)' },
    ]);
  });

  it('renders media on both sides of a card', () => {
    const card = renderCard(`![shot](media:${MEDIA_A}) shows {{c1::the flag}}`, 1);
    expect(card.front[0]).toEqual({ kind: 'media', alt: 'shot', id: MEDIA_A });
    expect(card.back[0]).toEqual({ kind: 'media', alt: 'shot', id: MEDIA_A });
  });

  it('collects referenced ids without duplicates', () => {
    const src = `![a](media:${MEDIA_A}) ![b](media:${MEDIA_B}) ![c](media:${MEDIA_A})`;
    expect(mediaIdsIn(src)).toEqual([MEDIA_A, MEDIA_B]);
  });

  it('finds no ids in a note without media', () => {
    expect(mediaIdsIn('{{c1::a}}')).toEqual([]);
  });

  it('is not confused by consecutive calls, despite a shared regex', () => {
    const src = `![a](media:${MEDIA_A})`;
    expect(mediaIdsIn(src)).toEqual([MEDIA_A]);
    expect(mediaIdsIn(src)).toEqual([MEDIA_A]);
    expect(splitMedia(src)).toHaveLength(1);
    expect(splitMedia(src)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

describe('segmentsToText', () => {
  it('uses the alt text for media', () => {
    expect(segmentsToText(splitMedia(`x ![shot](media:${MEDIA_A})`))).toBe('x [shot]');
  });

  it('falls back to a generic label when alt is empty', () => {
    expect(segmentsToText(splitMedia(`![](media:${MEDIA_A})`))).toBe('[image]');
  });
});
