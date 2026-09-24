import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { createDeck, getSettings, listDecks } from '../repo';
import { allQueueCounts, totalOf, type QueueCounts } from '../review';
import { Dialog } from '../ui/Dialog';
import { cloudEnabled } from '../db/cloud';

/**
 * Counts come from the queue builder, not from raw due counts, so the numbers
 * shown here are exactly what a session will hand over. Promising 40 due and
 * then stopping at 20 because of a daily limit is the kind of small dishonesty
 * that makes an app feel broken.
 */
function Counts({ counts }: { counts: QueueCounts | undefined }) {
  const learning = counts?.learning ?? 0;
  const review = counts?.review ?? 0;
  const fresh = counts?.new ?? 0;

  return (
    <div className="counts">
      <div className={`count count--new${fresh === 0 ? ' count--zero' : ''}`}>
        <span className="count__n">{fresh}</span>
        <span className="count__label">New</span>
      </div>
      <div className={`count count--learn${learning === 0 ? ' count--zero' : ''}`}>
        <span className="count__n">{learning}</span>
        <span className="count__label">Learn</span>
      </div>
      <div className={`count count--due${review === 0 ? ' count--zero' : ''}`}>
        <span className="count__n">{review}</span>
        <span className="count__label">Due</span>
      </div>
    </div>
  );
}

export function DeckList() {
  const decks = useLiveQuery(() => listDecks(), []);
  const counts = useLiveQuery(async () => {
    const [all, settings] = await Promise.all([listDecks(), getSettings()]);
    return allQueueCounts(all, settings.rolloverHour);
  }, []);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  function openCreate() {
    setName('');
    setDescription('');
    setError('');
    setCreating(true);
  }

  async function submit() {
    try {
      await createDeck({ name, description });
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Decks</h1>
          <p className="muted small">
            Cloze deletion flashcards, {cloudEnabled ? 'synced to your account' : 'stored in this browser'}.
          </p>
        </div>
        <button className="primary" onClick={openCreate}>
          New deck
        </button>
      </div>

      {decks === undefined ? null : decks.length === 0 ? (
        <div className="empty">
          <h2>No decks yet</h2>
          <p>Create one to start adding cloze cards.</p>
          <button className="primary" onClick={openCreate}>
            Create your first deck
          </button>
        </div>
      ) : (
        <ul className="deck-list">
          {decks.map((deck) => {
            const deckCounts = counts?.get(deck.id);
            const due = deckCounts ? totalOf(deckCounts) : 0;
            return (
              <li key={deck.id} className="deck-card">
                <div className="deck-card__body">
                  <Link to={`/deck/${deck.id}`} className="deck-card__name">
                    {deck.name}
                  </Link>
                  {deck.description ? (
                    <div className="deck-card__desc">{deck.description}</div>
                  ) : null}
                </div>
                <Counts counts={deckCounts} />
                {due > 0 ? (
                  <Link className="button primary deck-card__study" to={`/deck/${deck.id}/review`}>
                    Study
                  </Link>
                ) : (
                  <span className="deck-card__study deck-card__study--done small faint">done</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={creating}
        title="New deck"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button onClick={() => setCreating(false)}>Cancel</button>
            <button className="primary" onClick={submit}>
              Create
            </button>
          </>
        }
      >
        <div>
          <label htmlFor="deck-name">Name</label>
          <input
            id="deck-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="PEN-200 — Enumeration"
          />
        </div>
        <div>
          <label htmlFor="deck-desc">Description (optional)</label>
          <input
            id="deck-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this deck covers"
          />
        </div>
        {error ? <p className="field-error">{error}</p> : null}
      </Dialog>
    </>
  );
}
