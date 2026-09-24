/**
 * Browse: every note in every deck, searchable, with bulk actions.
 *
 * Three decisions worth knowing:
 *
 * **The query lives in the URL** (`#/browse?q=…&sort=…`). Opening a note to
 * edit it and coming back restores the search, the back button walks through
 * earlier searches, and a search can be bookmarked. Typing updates the URL
 * with `replace`, so a word typed letter by letter is one history entry, not
 * nine.
 *
 * **Bulk actions apply to the selected notes that still match.** Selection
 * survives changing the search, but an action only ever touches rows that are
 * in the current result — the count on the action bar is exactly the number
 * that will change. Silently tagging notes the person can no longer see is
 * the kind of thing that makes people distrust bulk edits.
 *
 * **Delete is undoable, not confirmed twice.** It's a soft delete, so the
 * result banner carries an Undo that restores the same cards with their
 * history. One confirmation dialog, then a real undo, beats a second "are you
 * really sure".
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  filterEntries,
  indexNotes,
  nextDue,
  parseQuery,
  sortEntries,
  withFilter,
  type BrowseEntry,
  type Clock,
  type SortDir,
  type SortKey,
} from '../browse';
import {
  addTagsToNotes,
  allTags,
  deleteNotes,
  getSettings,
  listDecks,
  loadBrowseData,
  moveNotes,
  removeTagsFromNotes,
  restoreNotes,
  setNotesSuspended,
} from '../repo';
import { dayEnd, dayStart, formatDate, formatInterval } from '../lib/time';
import { plural } from '../lib/text';
import { Dialog } from '../ui/Dialog';
import { TagInput } from '../ui/TagInput';

const PAGE = 100;
const SORT_KEYS: readonly SortKey[] = ['note', 'deck', 'due', 'added', 'edited'];
const DEBOUNCE_MS = 150;

/** One-click filters under the search box. Clicking adds the clause. */
const QUICK_FILTERS: { label: string; field: string; value: string }[] = [
  { label: 'Due today', field: 'is', value: 'due' },
  { label: 'New', field: 'is', value: 'new' },
  { label: 'Suspended', field: 'is', value: 'suspended' },
  { label: 'No cards', field: 'is', value: 'empty' },
  { label: 'Untagged', field: 'tag', value: 'none' },
  { label: 'Basic', field: 'type', value: 'basic' },
  { label: 'Added this week', field: 'added', value: '7' },
];

type BulkDialog = 'add-tag' | 'remove-tag' | 'move' | 'delete' | null;

interface Outcome {
  message: string;
  /** Present after a delete: the ids to restore. */
  undo?: string[];
}

function dueLabel(entry: BrowseEntry, clock: Clock, now: number): string {
  if (entry.cards.length === 0) return 'no cards';
  const due = nextDue(entry);
  if (due !== null) return due < clock.dueBy ? 'due' : `in ${formatInterval(due - now)}`;
  if (entry.cards.some((c) => !c.suspended)) return 'new';
  return 'suspended';
}

export function Browse() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sortParam = params.get('sort') as SortKey | null;
  const sortKey: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : 'edited';
  const sortDir: SortDir = params.get('dir') === 'asc' ? 'asc' : 'desc';

  // --- search input, debounced into the URL ------------------------------
  const [input, setInput] = useState(q);
  const [syncedQ, setSyncedQ] = useState(q);
  // The URL changed underneath us (back button, a chip, a link from a deck):
  // follow it. Adjusted during render rather than in an effect, so the box
  // never paints the stale value.
  if (q !== syncedQ) {
    setSyncedQ(q);
    setInput(q);
  }

  const updateParams = useCallback(
    (patch: Record<string, string | null>, replace = true) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  useEffect(() => {
    if (input === q) return;
    const t = setTimeout(() => updateParams({ q: input }), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, q, updateParams]);

  /** Set the query right away — for chips and filters, which shouldn't wait. */
  function setQuery(next: string) {
    setInput(next);
    setSyncedQ(next);
    updateParams({ q: next }, false);
  }

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // "/" focuses search, as in most tools with a search box — unless the
    // person is already typing somewhere.
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- data --------------------------------------------------------------
  // `loadedAt` is stamped with the data rather than read during render, so
  // "due today" is measured against when the rows were read — and a session
  // left open past the rollover picks up the new study day on the next write.
  const data = useLiveQuery(async () => ({ ...(await loadBrowseData()), loadedAt: Date.now() }), []);
  const settings = useLiveQuery(() => getSettings(), []);
  const decks = useLiveQuery(() => listDecks(), []);
  const tagSuggestions = useLiveQuery(() => allTags(), []);

  const index = useMemo(() => (data ? indexNotes(data) : null), [data]);
  const parsed = useMemo(() => parseQuery(q), [q]);

  const rollover = settings?.rolloverHour ?? 4;
  const now = data?.loadedAt ?? 0;
  const clock: Clock = useMemo(
    () => ({ todayStart: dayStart(now, rollover), dueBy: dayEnd(now, rollover) }),
    [now, rollover],
  );

  const results = useMemo(
    () => (index ? sortEntries(filterEntries(index, parsed, clock), sortKey, sortDir) : null),
    [index, parsed, clock, sortKey, sortDir],
  );

  // --- paging ------------------------------------------------------------
  const [limit, setLimit] = useState(PAGE);
  const [limitFor, setLimitFor] = useState(q);
  if (limitFor !== q) {
    setLimitFor(q);
    setLimit(PAGE);
  }
  const shown = results ? results.slice(0, limit) : [];

  // --- selection ---------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<number | null>(null);

  const selectedIds = useMemo(
    () => (results ? results.filter((e) => selected.has(e.note.id)).map((e) => e.note.id) : []),
    [results, selected],
  );
  const allSelected = !!results && results.length > 0 && selectedIds.length === results.length;

  function toggleRow(i: number, e: MouseEvent<HTMLInputElement>) {
    if (!results) return;
    const id = results[i].note.id;
    const on = !selected.has(id);
    const next = new Set(selected);
    // Shift-click selects (or clears) the whole run from the last click.
    if (e.shiftKey && anchor.current !== null) {
      const [from, to] = anchor.current < i ? [anchor.current, i] : [i, anchor.current];
      for (let k = from; k <= to; k++) {
        if (on) next.add(results[k].note.id);
        else next.delete(results[k].note.id);
      }
    } else if (on) next.add(id);
    else next.delete(id);
    anchor.current = i;
    setSelected(next);
  }

  function toggleAll() {
    if (!results) return;
    setSelected(allSelected ? new Set() : new Set(results.map((e) => e.note.id)));
    anchor.current = null;
  }

  // --- sorting -----------------------------------------------------------
  function sortBy(key: SortKey) {
    // Dates and due default to newest/soonest-first on the first click; text
    // columns to A→Z.
    const firstDir: SortDir = key === 'note' || key === 'deck' || key === 'due' ? 'asc' : 'desc';
    const dir: SortDir = key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : firstDir;
    updateParams({ sort: key, dir }, true);
  }

  /** A sortable column header. A render helper, not a component, so React doesn't remount it every render. */
  function sortHeader(k: SortKey, label: string, className?: string) {
    const active = k === sortKey;
    return (
      <th className={className} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`browse__sort${active ? ' on' : ''}`} onClick={() => sortBy(k)}>
          {label}
          <span className="browse__arrow" aria-hidden="true">
            {active ? (sortDir === 'asc' ? '↑' : '↓') : ''}
          </span>
        </button>
      </th>
    );
  }

  // --- bulk actions ------------------------------------------------------
  const [dialog, setDialog] = useState<BulkDialog>(null);
  const [dialogTags, setDialogTags] = useState<string[]>([]);
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState('');

  const selectedTags = useMemo(() => {
    if (!results || dialog !== 'remove-tag') return [];
    const ids = new Set(selectedIds);
    const seen = new Set<string>();
    for (const e of results) if (ids.has(e.note.id)) for (const t of e.note.tags) seen.add(t);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [results, selectedIds, dialog]);

  function open(which: Exclude<BulkDialog, null>) {
    setDialogTags([]);
    setMoveTo('');
    setError('');
    setDialog(which);
  }

  async function run(action: () => Promise<Outcome>) {
    setBusy(true);
    setError('');
    try {
      setOutcome(await action());
      setDialog(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const n = selectedIds.length;
  const notesWord = (k: number) => plural(k, 'note');

  const doAddTags = () =>
    run(async () => {
      const changed = await addTagsToNotes(selectedIds, dialogTags);
      const already = n - changed;
      return {
        message: `Tagged ${notesWord(changed)}${already ? ` (${already} already had ${dialogTags.length === 1 ? 'it' : 'them'})` : ''}.`,
      };
    });

  const doRemoveTags = () =>
    run(async () => {
      const changed = await removeTagsFromNotes(selectedIds, dialogTags);
      return { message: `Removed ${plural(dialogTags.length, 'tag')} from ${notesWord(changed)}.` };
    });

  const doMove = () =>
    run(async () => {
      const moved = await moveNotes(selectedIds, moveTo);
      const deckName = decks?.find((d) => d.id === moveTo)?.name ?? 'the deck';
      const already = n - moved;
      return {
        message: `Moved ${notesWord(moved)} to ${deckName}${already ? ` (${already} already there)` : ''}.`,
      };
    });

  const doSuspend = (suspend: boolean) =>
    run(async () => {
      const cards = await setNotesSuspended(selectedIds, suspend);
      return {
        message: cards
          ? `${suspend ? 'Suspended' : 'Unsuspended'} ${plural(cards, 'card')}.`
          : `Nothing to ${suspend ? 'suspend' : 'unsuspend'} — every card was already ${suspend ? 'suspended' : 'active'}.`,
      };
    });

  const doDelete = () =>
    run(async () => {
      const deleted = await deleteNotes(selectedIds);
      setSelected(new Set());
      return { message: `Deleted ${notesWord(deleted.length)}.`, undo: deleted };
    });

  async function undoDelete(ids: string[]) {
    setBusy(true);
    try {
      await restoreNotes(ids);
      setSelected(new Set(ids));
      setOutcome({ message: `Restored ${notesWord(ids.length)}.` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // --- render ------------------------------------------------------------
  const returnTo = `/browse${params.toString() ? `?${params.toString()}` : ''}`;
  const loading = results === null;
  const empty = !!index && index.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Browse</h1>
          <p className="muted small">Every note in every deck. Press / to search.</p>
        </div>
      </div>

      <div className="browse__search">
        <label htmlFor="browse-q" className="sr-only">
          Search notes
        </label>
        <input
          id="browse-q"
          ref={searchRef}
          type="search"
          value={input}
          placeholder='Search — try  kerberos  tag:ad  is:due  deck:"Active Directory"'
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && input) {
              e.preventDefault();
              setQuery('');
            }
          }}
        />
        <div className="browse__chips">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              className="chip chip--ghost"
              onClick={() => setQuery(withFilter(input, f.field, f.value))}
            >
              {f.label}
            </button>
          ))}
          <details className="browse__help">
            <summary className="small faint">Search syntax</summary>
            <table className="browse__syntax small">
              <tbody>
                <tr><td><code>word</code></td><td>appears anywhere — front, back or extra</td></tr>
                <tr><td><code>"two words"</code></td><td>the exact phrase</td></tr>
                <tr><td><code>net*</code></td><td>wildcard (within a word)</td></tr>
                <tr><td><code>-word</code></td><td>exclude; works on any filter too</td></tr>
                <tr><td><code>tag:ad</code></td><td>has the tag · <code>tag:none</code> untagged</td></tr>
                <tr><td><code>deck:"Name"</code></td><td>in that deck (<code>*</code> works)</td></tr>
                <tr><td><code>type:basic</code></td><td>or <code>type:cloze</code></td></tr>
                <tr><td><code>is:due</code></td><td>also <code>new</code> <code>learning</code> <code>review</code> <code>suspended</code> <code>empty</code></td></tr>
                <tr><td><code>added:7</code></td><td>created in the last 7 days · <code>edited:7</code></td></tr>
              </tbody>
            </table>
            <p className="small faint">Everything is combined with AND. Case and accents are ignored.</p>
          </details>
        </div>
        {parsed.warnings.length ? (
          <ul className="browse__warnings small">
            {parsed.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {outcome ? (
        <div className="banner" role="status">
          <p>{outcome.message}</p>
          {outcome.undo?.length ? (
            <button disabled={busy} onClick={() => void undoDelete(outcome.undo!)}>
              Undo
            </button>
          ) : null}
          <button className="ghost" onClick={() => setOutcome(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {error && !dialog ? (
        <div className="banner banner--warn">
          <p>{error}</p>
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      ) : null}

      <div className={`browse__bar${n ? ' browse__bar--active' : ''}`}>
        <span className="browse__count small">
          {loading
            ? 'Loading…'
            : n
              ? `${n} of ${plural(results!.length, 'note')} selected`
              : q.trim()
                ? `${plural(results!.length, 'note')} match`
                : plural(results!.length, 'note')}
        </span>
        {n ? (
          <div className="browse__actions">
            <button onClick={() => open('add-tag')}>Add tag</button>
            <button onClick={() => open('remove-tag')}>Remove tag</button>
            <button onClick={() => open('move')}>Move…</button>
            <button disabled={busy} onClick={() => void doSuspend(true)}>
              Suspend
            </button>
            <button disabled={busy} onClick={() => void doSuspend(false)}>
              Unsuspend
            </button>
            <button className="danger" onClick={() => open('delete')}>
              Delete
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        ) : null}
      </div>

      {loading ? null : empty ? (
        <div className="empty">
          <h2>No notes yet</h2>
          <p>Notes you add to any deck show up here.</p>
          <Link className="button primary" to="/">
            Go to decks
          </Link>
        </div>
      ) : results!.length === 0 ? (
        <div className="empty">
          <h2>Nothing matches</h2>
          <p>No note matches “{q.trim()}”.</p>
          <button onClick={() => setQuery('')}>Clear search</button>
        </div>
      ) : (
        <>
          <div className="browse__tablewrap">
            <table className="browse__table">
              <thead>
                <tr>
                  <th className="browse__check">
                    <input
                      type="checkbox"
                      aria-label={allSelected ? 'Clear selection' : `Select all ${results!.length}`}
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && !allSelected;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  {sortHeader('note', 'Note')}
                  {sortHeader('deck', 'Deck', 'browse__col-deck')}
                  <th className="browse__col-tags">Tags</th>
                  {sortHeader('due', 'Due', 'browse__col-due')}
                  {sortHeader('edited', 'Edited', 'browse__col-date')}
                </tr>
              </thead>
              <tbody>
                {shown.map((entry, i) => {
                  const { note } = entry;
                  const isSel = selected.has(note.id);
                  const suspended = entry.cards.filter((c) => c.suspended).length;
                  const due = dueLabel(entry, clock, now);
                  return (
                    <tr key={note.id} className={isSel ? 'is-selected' : undefined}>
                      <td className="browse__check">
                        <input
                          type="checkbox"
                          aria-label="Select note"
                          checked={isSel}
                          onChange={() => undefined}
                          onClick={(e) => toggleRow(i, e)}
                        />
                      </td>
                      <td className="browse__note">
                        <Link to={`/deck/${note.deckId}/note/${note.id}`} state={{ returnTo }}>
                          {entry.summary || <span className="faint">(empty)</span>}
                        </Link>
                        <span className="browse__sub small faint">
                          {note.type === 'basic' ? 'basic · ' : ''}
                          {plural(entry.cards.length, 'card')}
                          {suspended ? ` · ${suspended} suspended` : ''}
                        </span>
                      </td>
                      <td className="browse__col-deck">
                        <button
                          type="button"
                          className="browse__link"
                          title={`Only notes in ${entry.deckName}`}
                          onClick={() => setQuery(withFilter(input, 'deck', entry.deckName))}
                        >
                          {entry.deckName}
                        </button>
                      </td>
                      <td className="browse__col-tags">
                        {note.tags.map((t) => (
                          <button
                            key={t}
                            type="button"
                            className="chip chip--mini browse__tag"
                            title={`Only notes tagged ${t}`}
                            onClick={() => setQuery(withFilter(input, 'tag', t))}
                          >
                            {t}
                          </button>
                        ))}
                      </td>
                      <td className={`browse__col-due small${due === 'due' ? ' browse__due' : ''}`}>{due}</td>
                      <td className="browse__col-date small faint">{formatDate(note.modified)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {results!.length > shown.length ? (
            <div className="browse__more">
              <button onClick={() => setLimit((l) => l + PAGE * 5)}>
                Show more ({results!.length - shown.length} hidden)
              </button>
            </div>
          ) : null}
        </>
      )}

      <Dialog
        open={dialog === 'add-tag' || dialog === 'remove-tag'}
        title={dialog === 'remove-tag' ? `Remove tags from ${notesWord(n)}` : `Tag ${notesWord(n)}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button
              className="primary"
              disabled={busy || dialogTags.length === 0}
              onClick={() => void (dialog === 'remove-tag' ? doRemoveTags() : doAddTags())}
            >
              {dialog === 'remove-tag' ? 'Remove' : 'Add'}
            </button>
          </>
        }
      >
        <div>
          <label htmlFor="bulk-tags">Tags</label>
          <TagInput
            id="bulk-tags"
            tags={dialogTags}
            onChange={setDialogTags}
            suggestions={dialog === 'remove-tag' ? selectedTags : tagSuggestions}
          />
        </div>
        {dialog === 'remove-tag' && selectedTags.length === 0 ? (
          <p className="small muted">None of the selected notes have any tags.</p>
        ) : null}
        {error ? <p className="field-error">{error}</p> : null}
      </Dialog>

      <Dialog
        open={dialog === 'move'}
        title={`Move ${notesWord(n)}`}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary" disabled={busy || !moveTo} onClick={() => void doMove()}>
              Move
            </button>
          </>
        }
      >
        <div>
          <label htmlFor="bulk-deck">To deck</label>
          <select id="bulk-deck" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="" disabled>
              Choose a deck…
            </option>
            {(decks ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <p className="small muted">
          Cards keep their scheduling and review history; they just count toward the new deck's
          daily limits from now on.
        </p>
        {error ? <p className="field-error">{error}</p> : null}
      </Dialog>

      <Dialog
        open={dialog === 'delete'}
        title={`Delete ${notesWord(n)}?`}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="danger" disabled={busy} onClick={() => void doDelete()}>
              Delete {notesWord(n)}
            </button>
          </>
        }
      >
        <p className="small">Their cards stop appearing in reviews.</p>
        <p className="small muted">
          You can undo this right after. Scheduling history is kept either way.
        </p>
        {error ? <p className="field-error">{error}</p> : null}
      </Dialog>
    </>
  );
}
