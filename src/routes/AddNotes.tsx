/**
 * Quick add.
 *
 * The screen stays open after a save, with the deck and tags sticky and the
 * caret back in the text area. That is Anki's add-window flow, and speed here
 * is what decides whether the app actually gets used: a round trip back to the
 * deck page after every note is enough friction to stop you adding the fourth.
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { createNote, getDeck, tagsInDeck } from '../repo';
import { NoteEditor } from '../ui/NoteEditor';
import { EMPTY_DRAFT, type NoteDraft } from '../notetypes';

const EMPTY = EMPTY_DRAFT;

export function AddNotes() {
  const { deckId = '' } = useParams();
  const navigate = useNavigate();

  const deck = useLiveQuery(async () => (await getDeck(deckId)) ?? null, [deckId]);
  const suggestions = useLiveQuery(() => tagsInDeck(deckId), [deckId]);

  const [draft, setDraft] = useState<NoteDraft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState(0);
  const [error, setError] = useState('');
  const [openFor, setOpenFor] = useState(deckId);

  // Tags stay sticky across saves, but not across decks — carrying one deck's
  // tags into another is never what you meant. Resetting during render rather
  // than in an effect keeps a stale draft from painting for a frame.
  if (openFor !== deckId) {
    setOpenFor(deckId);
    setDraft(EMPTY);
    setAdded(0);
    setError('');
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const { cards } = await createNote({
        deckId,
        type: draft.type,
        text: draft.text,
        back: draft.back,
        reverse: draft.reverse,
        extra: draft.extra,
        tags: draft.tags,
      });
      setAdded((n) => n + 1);
      // Clear the content but keep the shape of what you are doing: the next
      // note is usually a sibling of this one.
      setDraft({
        ...EMPTY,
        type: draft.type,
        reverse: draft.reverse,
        tags: draft.tags,
      });
      if (cards.length === 0) {
        setError('Saved, but that note generated no cards.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (deck === undefined) return null;
  if (deck === null) {
    return (
      <div className="empty">
        <h2>Deck not found</h2>
        <p>
          <Link to="/">Back to decks</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small faint">
            <Link to="/">Decks</Link> / <Link to={`/deck/${deckId}`}>{deck.name}</Link>
          </p>
          <h1>Add cards</h1>
        </div>
        <button onClick={() => navigate(`/deck/${deckId}`)}>Done</button>
      </div>

      {error ? <div className="banner banner--warn">{error}</div> : null}

      <NoteEditor
        value={draft}
        onChange={setDraft}
        onSave={save}
        onCancel={() => navigate(`/deck/${deckId}`)}
        saving={saving}
        saveLabel="Add note"
        autoFocus
        suggestions={suggestions}
        status={added ? `${added} note${added === 1 ? '' : 's'} added` : undefined}
      />
    </>
  );
}
