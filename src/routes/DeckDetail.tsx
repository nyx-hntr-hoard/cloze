import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  cardsForNote,
  countNotes,
  deckStats,
  deleteDeck,
  getDeck,
  getSettings,
  notesInDeck,
  updateDeck,
  type DeckConfig,
} from '../repo';
import { queueCounts, totalOf } from '../review';
import { noteSummaryOf } from '../notetypes';
import { downloadBlob } from '../backup';
import { exportDeckCsv } from '../csv';
import { withFilter } from '../browse';
import { Dialog } from '../ui/Dialog';
import { formatDate } from '../lib/time';

/** Recent notes in the deck, with the card count each one generates. */
async function recentNotes(deckId: string, limit: number) {
  const notes = (await notesInDeck(deckId)).slice(0, limit);
  return Promise.all(
    notes.map(async (note) => ({ note, cards: (await cardsForNote(note.id)).length })),
  );
}

const NOTE_LIMIT = 25;

export function DeckDetail() {
  const { deckId = '' } = useParams();
  const navigate = useNavigate();

  // `undefined` means the query hasn't resolved; `null` means no such deck.
  // Without the coalesce the two are indistinguishable and a missing deck
  // renders as a permanent blank page.
  const deck = useLiveQuery(async () => (await getDeck(deckId)) ?? null, [deckId]);
  const stats = useLiveQuery(() => deckStats(deckId), [deckId]);
  const noteCount = useLiveQuery(() => countNotes(deckId), [deckId]);
  const notes = useLiveQuery(() => recentNotes(deckId, NOTE_LIMIT), [deckId]);
  const queue = useLiveQuery(async () => {
    const [d, settings] = await Promise.all([getDeck(deckId), getSettings()]);
    return d ? queueCounts(d, settings.rolloverHour) : null;
  }, [deckId]);
  const dueNow = queue ? totalOf(queue) : 0;

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [config, setConfig] = useState<DeckConfig | null>(null);
  const [error, setError] = useState('');
  const [csvError, setCsvError] = useState('');
  const [exportingCsv, setExportingCsv] = useState(false);

  if (deck === undefined) return null;
  if (deck === null) {
    return (
      <div className="empty">
        <h2>Deck not found</h2>
        <p>It may have been deleted.</p>
        <Link to="/">Back to decks</Link>
      </div>
    );
  }

  function openEdit() {
    if (!deck) return;
    setName(deck.name);
    setDescription(deck.description);
    setConfig({ ...deck.config });
    setError('');
    setEditing(true);
  }

  async function saveEdit() {
    if (!config) return;
    try {
      await updateDeck(deckId, { name, description, config });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmDelete() {
    await deleteDeck(deckId);
    setConfirming(false);
    navigate('/');
  }

  async function exportCsv() {
    setExportingCsv(true);
    setCsvError('');
    try {
      const file = await exportDeckCsv(deckId);
      downloadBlob(file.blob, file.filename);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportingCsv(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small faint">
            <Link to="/">Decks</Link>
          </p>
          <h1>{deck.name}</h1>
          {deck.description ? <p className="muted small">{deck.description}</p> : null}
        </div>
        <div className="row">
          <button onClick={openEdit}>Edit</button>
          <button className="danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      </div>

      {csvError ? (
        <div className="banner banner--warn">
          <p>{csvError}</p>
          <button onClick={() => setCsvError('')}>Dismiss</button>
        </div>
      ) : null}

      <div className="panel stack">
        <div className="spread">
          <div>
            <div className="setting__label">
              {noteCount ?? 0} {noteCount === 1 ? 'note' : 'notes'} · {stats?.total ?? 0} cards
            </div>
            <div className="setting__hint">
              {queue ? (
                <>
                  {queue.new} new, {queue.learning} learning, {queue.review} due
                </>
              ) : (
                <>{stats?.total ?? 0} cards</>
              )}
              {stats?.suspended ? `, ${stats.suspended} suspended` : ''} · created{' '}
              {formatDate(deck.created)}
            </div>
          </div>
          <div className="row">
            <Link className="button" to={`/deck/${deckId}/add`}>
              Add cards
            </Link>
            <Link className="button" to={`/deck/${deckId}/import-csv`}>
              Import CSV
            </Link>
            <button disabled={exportingCsv || !noteCount} onClick={() => void exportCsv()}>
              {exportingCsv ? 'Exporting…' : 'Export CSV'}
            </button>
            <Link
              className={`button primary${dueNow === 0 ? ' button--disabled' : ''}`}
              to={dueNow === 0 ? `/deck/${deckId}` : `/deck/${deckId}/review`}
              aria-disabled={dueNow === 0}
            >
              {dueNow === 0 ? 'Nothing due' : `Study ${dueNow}`}
            </Link>
          </div>
        </div>
      </div>

      {notes === undefined ? null : notes.length === 0 ? (
        <div className="empty" style={{ marginTop: '1.25rem' }}>
          <h2>No notes yet</h2>
          <p>Add your first cloze deletion to start building this deck.</p>
          <Link className="button primary" to={`/deck/${deckId}/add`}>
            Add cards
          </Link>
        </div>
      ) : (
        <section className="notes">
          <div className="notes__head">
            <h2>Notes</h2>
            <span className="small faint">
              {noteCount && noteCount > notes.length ? `showing ${notes.length} of ${noteCount} · ` : ''}
              <Link to={`/browse?${new URLSearchParams({ q: withFilter('', 'deck', deck.name) })}`}>
                Search this deck
              </Link>
            </span>
          </div>
          <ul className="note-list">
            {notes.map(({ note, cards }) => (
              <li key={note.id} className="note-row">
                <Link to={`/deck/${deckId}/note/${note.id}`} className="note-row__text">
                  {noteSummaryOf(note)}
                </Link>
                <div className="note-row__meta">
                  {note.tags.length ? (
                    <span className="note-row__tags">
                      {note.tags.map((t) => (
                        <span key={t} className="chip chip--mini">
                          {t}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="note-row__cards small faint">
                    {cards} card{cards === 1 ? '' : 's'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog
        open={editing}
        title="Deck settings"
        onClose={() => setEditing(false)}
        footer={
          <>
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button className="primary" onClick={saveEdit}>
              Save
            </button>
          </>
        }
      >
        <div>
          <label htmlFor="edit-name">Name</label>
          <input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="edit-desc">Description</label>
          <input
            id="edit-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {config ? (
          <>
            <div>
              <label htmlFor="edit-new">New cards per day</label>
              <input
                id="edit-new"
                type="number"
                min={0}
                value={config.newPerDay}
                onChange={(e) => setConfig({ ...config, newPerDay: Number(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label htmlFor="edit-rev">Maximum reviews per day (0 = unlimited)</label>
              <input
                id="edit-rev"
                type="number"
                min={0}
                value={config.reviewsPerDay}
                onChange={(e) =>
                  setConfig({ ...config, reviewsPerDay: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div>
              <label htmlFor="edit-roll">Day starts at</label>
              <select
                id="edit-roll"
                value={config.rolloverHour}
                onChange={(e) => setConfig({ ...config, rolloverHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        {error ? <p className="field-error">{error}</p> : null}
      </Dialog>

      <Dialog
        open={confirming}
        title={`Delete "${deck.name}"?`}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger" onClick={confirmDelete}>
              Delete deck
            </button>
          </>
        }
      >
        <p className="small">
          This permanently removes {noteCount ?? 0} notes, {stats?.total ?? 0} cards and all of their
          review history. It cannot be undone.
        </p>
        <p className="small muted">Export the deck first if you might want it back.</p>
      </Dialog>
    </>
  );
}
