/**
 * Edit an existing note.
 *
 * Saving runs card reconciliation, so the screen shows what that did — cards
 * added or retired — rather than leaving the author to guess. Retiring is not
 * destructive (soft delete keeps the scheduling history), and saying so is what
 * makes editing feel safe enough to actually do.
 */

import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { cardsForNote, deleteNote, getNote, tagsInDeck, updateNote } from '../repo';
import { NoteEditor } from '../ui/NoteEditor';
import { draftFromNote, type NoteDraft } from '../notetypes';
import { Dialog } from '../ui/Dialog';
import { formatDate } from '../lib/time';

export function EditNote() {
  const { deckId = '', noteId = '' } = useParams();
  const navigate = useNavigate();
  // Opened from Browse? Go back there — search intact — rather than to the
  // deck page. Only an in-app path is honoured.
  const from = (useLocation().state as { returnTo?: unknown } | null)?.returnTo;
  const returnTo = typeof from === 'string' && from.startsWith('/') ? from : null;
  const exitTo = returnTo ?? `/deck/${deckId}`;

  const note = useLiveQuery(async () => (await getNote(noteId)) ?? null, [noteId]);
  const cards = useLiveQuery(() => cardsForNote(noteId), [noteId]);
  const suggestions = useLiveQuery(() => tagsInDeck(deckId), [deckId]);

  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  // Seed the draft when the note arrives, and re-seed if a different note is
  // opened. Adjusting state during render rather than in an effect: React
  // restarts the render before committing, so the editor never paints empty
  // and there is no second pass. Once seeded, incoming changes from the live
  // query are ignored — clobbering an in-progress edit would be worse than
  // being briefly stale.
  if (note && seededFor !== note.id) {
    setSeededFor(note.id);
    setDraft(draftFromNote(note));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const before = new Set((cards ?? []).map((c) => c.ordinal));
      const result = await updateNote(noteId, {
        type: draft.type,
        text: draft.text,
        back: draft.back,
        reverse: draft.reverse,
        extra: draft.extra,
        tags: draft.tags,
      });
      const after = new Set(result.cards.map((c) => c.ordinal));

      const created = [...after].filter((n) => !before.has(n));
      const retired = [...before].filter((n) => !after.has(n));

      // Name the change the way the author thinks of it: a cloze author edits
      // "c2", a basic author turns the reverse card on and off.
      const name = (ordinals: number[]) =>
        draft.type === 'basic'
          ? ordinals.includes(2)
            ? 'the reverse card'
            : 'the card'
          : `c${ordinals.join(', c')}`;

      const parts: string[] = ['Saved'];
      if (created.length) parts.push(`added ${name(created)}`);
      if (retired.length) parts.push(`retired ${name(retired)}`);
      setStatus(parts.join(' · '));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    await deleteNote(noteId);
    setConfirming(false);
    navigate(exitTo);
  }

  if (note === undefined || !draft) return null;
  if (note === null) {
    return (
      <div className="empty">
        <h2>Note not found</h2>
        <p>
          <Link to={`/deck/${deckId}`}>Back to the deck</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small faint">
            {returnTo ? (
              <Link to={returnTo}>← Back to browse</Link>
            ) : (
              <>
                <Link to="/">Decks</Link> / <Link to={`/deck/${deckId}`}>Deck</Link>
              </>
            )}
          </p>
          <h1>Edit note</h1>
          <p className="muted small">
            {cards?.length ?? 0} card{cards?.length === 1 ? '' : 's'} · edited{' '}
            {formatDate(note.modified)}
          </p>
        </div>
      </div>

      {error ? <div className="banner banner--warn">{error}</div> : null}

      <NoteEditor
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setStatus('');
        }}
        onSave={save}
        onCancel={() => navigate(exitTo)}
        onDelete={() => setConfirming(true)}
        saving={saving}
        saveLabel="Save"
        suggestions={suggestions}
        status={status}
      />

      <Dialog
        open={confirming}
        title="Delete this note?"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger" onClick={confirmDelete}>
              Delete note
            </button>
          </>
        }
      >
        <p className="small">
          Its {cards?.length ?? 0} card{cards?.length === 1 ? '' : 's'} will stop appearing in
          reviews.
        </p>
        <p className="small muted">
          The scheduling history is kept, so the note can be restored from a backup.
        </p>
      </Dialog>
    </>
  );
}
