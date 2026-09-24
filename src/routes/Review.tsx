/**
 * The review session.
 *
 * Keyboard first: space reveals and then answers Good, 1–4 grade directly, `u`
 * undoes, `e` edits. A reviewer's hands should never have to leave the keyboard
 * — that is most of what makes a hundred-card session tolerable.
 *
 * The queue is held in component state rather than re-read from the database
 * after every answer. Answering is then O(1), and a learning card that is due
 * again within the session horizon is spliced back in locally. When the local
 * queue runs dry the queue is rebuilt, which is what picks up learning cards
 * that have since come due.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { splitMedia } from '../cloze';
import { renderNoteCard } from '../notetypes';
import {
  answerCard,
  buildQueue,
  GRADE_LABELS,
  GRADES,
  kindOf,
  makeScheduler,
  previewGrades,
  reinsert,
  undoAnswer,
  type AnswerResult,
  type GradePreview,
  type Grade,
} from '../review';
import { getDeck, getFsrsParams, getNote, getSettings } from '../repo';
import type { Card } from '../repo';
import { SegmentView } from '../ui/SegmentView';
import { formatInterval } from '../lib/time';

function remainingWait(until: number | null): number {
  return until === null ? 0 : Math.max(0, until - Date.now());
}

/** Grade keys 1–4, matching the button order. */
const KEY_TO_GRADE: Record<string, Grade> = {
  '1': GRADES[0],
  '2': GRADES[1],
  '3': GRADES[2],
  '4': GRADES[3],
};

export function Review() {
  const { deckId = '' } = useParams();
  const navigate = useNavigate();

  const deck = useLiveQuery(async () => (await getDeck(deckId)) ?? null, [deckId]);
  const settings = useLiveQuery(() => getSettings(), []);
  const params = useLiveQuery(() => getFsrsParams(), []);

  const [queue, setQueue] = useState<Card[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [history, setHistory] = useState<AnswerResult[]>([]);
  const [answered, setAnswered] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null);
  const [cappedNew, setCappedNew] = useState(false);
  const [cappedReview, setCappedReview] = useState(false);
  const [error, setError] = useState('');
  /** Cards set aside this session because scheduling them threw. */
  const [skipped, setSkipped] = useState<string[]>([]);

  /** When the current side went on screen, for the answer-duration log. */
  const shownAt = useRef<number>(0);
  // Read inside `refill`, which must not be re-created whenever a card is
  // skipped — that would restart the timer that waits on learning cards.
  const skippedRef = useRef<string[]>([]);

  useEffect(() => {
    skippedRef.current = skipped;
  }, [skipped]);

  const scheduler = useMemo(() => (params ? makeScheduler(params) : null), [params]);

  const current = queue?.[0] ?? null;
  const note = useLiveQuery(
    async () => (current ? ((await getNote(current.noteId)) ?? null) : null),
    [current?.noteId],
  );

  // --- queue loading --------------------------------------------------

  const refill = useCallback(async () => {
    if (!deck || !settings) return;
    const built = await buildQueue(deck, settings.rolloverHour);
    const cards = built.cards.filter((c) => !skippedRef.current.includes(c.id));
    setQueue(cards);
    setCappedNew(built.cappedNew);
    setCappedReview(built.cappedReview);
    setWaitingUntil(cards.length === 0 ? (built.nextLearningAt ?? null) : null);
    setRevealed(false);
  }, [deck, settings]);

  useEffect(() => {
    if (deck && settings && queue === null) void refill();
  }, [deck, settings, queue, refill]);

  // A learning card is ticking; come back when it is due.
  useEffect(() => {
    if (waitingUntil === null) return;
    const delay = Math.max(500, waitingUntil - Date.now() + 250);
    const timer = setTimeout(() => void refill(), delay);
    return () => clearTimeout(timer);
  }, [waitingUntil, refill]);

  useEffect(() => {
    shownAt.current = Date.now();
  }, [current?.id, revealed]);

  // --- rendering ------------------------------------------------------

  const rendered = useMemo(() => {
    if (!current || !note) return null;
    return renderNoteCard(note, current.ordinal);
  }, [current, note]);

  const previews: GradePreview[] = useMemo(() => {
    if (!scheduler || !current) return [];
    return previewGrades(scheduler, current);
  }, [scheduler, current]);

  const remaining = useMemo(() => {
    const counts = { learning: 0, review: 0, new: 0 };
    for (const card of queue ?? []) counts[kindOf(card)]++;
    return counts;
  }, [queue]);

  // --- actions --------------------------------------------------------

  const grade = useCallback(
    async (g: Grade) => {
      if (!scheduler || !current || busy) return;
      setBusy(true);
      try {
        const result = await answerCard(
          scheduler,
          current,
          g,
          Date.now(),
          Date.now() - shownAt.current,
        );
        setHistory((h) => [...h, result]);
        setAnswered((n) => n + 1);

        const rest = (queue ?? []).slice(1);
        const next = reinsert(rest, result.card);
        setRevealed(false);

        if (next.length === 0) {
          setQueue([]);
          await refill();
        } else {
          setQueue(next);
        }
      } catch (e) {
        // FSRS rejects a card whose stored memory state is self-inconsistent —
        // not reachable by authoring, but an import could produce one. Set it
        // aside and keep the session going rather than losing it to one bad row.
        setSkipped((s) => [...s, current.id]);
        setQueue((q) => (q ?? []).slice(1));
        setRevealed(false);
        setError(
          `A card in this deck has damaged scheduling data and was skipped. ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      } finally {
        setBusy(false);
      }
    },
    [scheduler, current, busy, queue, refill],
  );

  const undo = useCallback(async () => {
    const last = history[history.length - 1];
    if (!last || busy) return;
    setBusy(true);
    try {
      await undoAnswer(last);
      setHistory((h) => h.slice(0, -1));
      setAnswered((n) => Math.max(0, n - 1));
      setQueue((q) => [last.previous, ...(q ?? []).filter((c) => c.id !== last.previous.id)]);
      setWaitingUntil(null);
      setRevealed(true);
    } finally {
      setBusy(false);
    }
  }, [history, busy]);

  // --- keyboard -------------------------------------------------------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === 'Escape') {
        navigate(`/deck/${deckId}`);
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        e.preventDefault();
        void undo();
        return;
      }
      if ((e.key === 'e' || e.key === 'E') && current) {
        e.preventDefault();
        navigate(`/deck/${deckId}/note/${current.noteId}`);
        return;
      }
      if (!current) return;

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else void grade(GRADES[2]); // Good
        return;
      }
      if (revealed && KEY_TO_GRADE[e.key] !== undefined) {
        e.preventDefault();
        void grade(KEY_TO_GRADE[e.key]);
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, current, grade, undo, navigate, deckId]);

  // --- states ---------------------------------------------------------

  if (deck === undefined || settings === undefined || params === undefined) return null;
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

  const done = queue !== null && queue.length === 0;

  return (
    <div className="review">
      <header className="review__bar">
        <button className="ghost" onClick={() => navigate(`/deck/${deckId}`)} title="Esc">
          ← {deck.name}
        </button>
        <div className="review__counts">
          <span className="rcount rcount--learning" title="Learning">
            {remaining.learning}
          </span>
          <span className="rcount rcount--review" title="Review">
            {remaining.review}
          </span>
          <span className="rcount rcount--new" title="New">
            {remaining.new}
          </span>
        </div>
        <button className="ghost" disabled={!history.length || busy} onClick={() => void undo()} title="u">
          Undo
        </button>
      </header>

      {error ? (
        <div className="banner banner--warn" style={{ marginTop: '1rem' }}>
          <p>{error}</p>
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      ) : null}

      {done ? (
        <FinishedPanel
          key={String(waitingUntil)}
          answered={answered}
          waitingUntil={waitingUntil}
          cappedNew={cappedNew}
          cappedReview={cappedReview}
          deckId={deckId}
          onUndo={history.length ? () => void undo() : undefined}
        />
      ) : !rendered || !note ? null : (
        <>
          <section
            className="review__card"
            onClick={() => !revealed && setRevealed(true)}
            role={revealed ? undefined : 'button'}
            tabIndex={revealed ? undefined : 0}
            onKeyDown={(e) => {
              if (!revealed && (e.key === ' ' || e.key === 'Enter')) setRevealed(true);
            }}
          >
            <div className="review__text">
              <SegmentView segments={revealed ? rendered.back : rendered.front} />
            </div>
            {revealed && note.extra ? (
              <div className="review__extra">
                <SegmentView segments={splitMedia(note.extra)} />
              </div>
            ) : null}
          </section>

          <footer className="review__answers">
            {!revealed ? (
              <button className="primary review__show" onClick={() => setRevealed(true)}>
                Show answer <kbd>space</kbd>
              </button>
            ) : (
              previews.map((p, i) => (
                <button
                  key={p.grade}
                  className={`review__grade review__grade--${GRADE_LABELS[p.grade].toLowerCase()}`}
                  disabled={busy}
                  onClick={() => void grade(p.grade)}
                >
                  <span className="review__grade-label">{p.label}</span>
                  <span className="review__grade-interval">{formatInterval(p.intervalMs)}</span>
                  <kbd>{i + 1}</kbd>
                </button>
              ))
            )}
          </footer>

          <p className="review__hint small faint">
            {revealed ? 'space = Good · 1–4 to grade' : 'space to reveal'} · e to edit · u to undo
          </p>
        </>
      )}
    </div>
  );
}

function FinishedPanel({
  answered,
  waitingUntil,
  cappedNew,
  cappedReview,
  deckId,
  onUndo,
}: {
  answered: number;
  waitingUntil: number | null;
  cappedNew: boolean;
  cappedReview: boolean;
  deckId: string;
  onUndo?: () => void;
}) {
  // A live countdown, so "up in 3m" does not sit there reading 3m for a minute.
  // The call site keys this component on `waitingUntil`, so a new wait remounts
  // and the initializer runs again rather than needing a reset effect.
  const [wait, setWait] = useState(() => remainingWait(waitingUntil));

  useEffect(() => {
    if (waitingUntil === null) return;
    const timer = setInterval(() => setWait(remainingWait(waitingUntil)), 1000);
    return () => clearInterval(timer);
  }, [waitingUntil]);

  return (
    <div className="empty review__done">
      <h2>{waitingUntil ? 'Nothing due right now' : 'Deck finished'}</h2>
      <p>
        {answered > 0
          ? `${answered} card${answered === 1 ? '' : 's'} answered this session.`
          : 'Nothing was due.'}
        {waitingUntil ? ` The next learning card is up in ${formatInterval(wait)}.` : ''}
      </p>

      {cappedNew || cappedReview ? (
        <p className="small muted">
          More cards are waiting but today&rsquo;s limit is reached
          {cappedNew && cappedReview
            ? ' for both new cards and reviews'
            : cappedNew
              ? ' for new cards'
              : ' for reviews'}
          . Raise it in the deck&rsquo;s settings to keep going.
        </p>
      ) : null}

      <div className="row" style={{ justifyContent: 'center' }}>
        {onUndo ? <button onClick={onUndo}>Undo last</button> : null}
        <Link className="button" to={`/deck/${deckId}/add`}>
          Add cards
        </Link>
        <Link className="button primary" to={`/deck/${deckId}`}>
          Back to deck
        </Link>
      </div>
    </div>
  );
}
