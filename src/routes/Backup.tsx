/**
 * Backup and restore.
 *
 * Given its own screen in the nav rather than a corner of Settings, because a
 * backup feature you have to go looking for is one you find out about after
 * losing something.
 *
 * Import always previews before it writes. The preview is the whole point: it
 * is what turns "restore" from a button you are afraid of into one you can
 * read before pressing.
 */

import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  downloadBlob,
  exportBackup,
  importBackup,
  planImport,
  readBackupFile,
  type ImportMode,
  type ImportOptions,
  type ImportPlan,
  type ImportResult,
  type LoadedBackup,
} from '../backup';
import { backupIsOverdue, getSettings, listDecks, markBackupTaken } from '../repo';
import { Dialog } from '../ui/Dialog';
import { Stat } from '../ui/Stat';
import { formatDate } from '../lib/time';
import { plural } from '../lib/text';
import { cloudEnabled } from '../db/cloud';

const MODES: { value: ImportMode; label: string; hint: string }[] = [
  {
    value: 'add',
    label: 'Add as new decks',
    hint: 'Nothing already here is touched. Importing the same file twice makes two copies.',
  },
  {
    value: 'merge',
    label: 'Merge into decks with the same name',
    hint: 'New notes are added; notes whose text already exists in that deck are skipped.',
  },
  {
    value: 'restore',
    label: 'Replace everything',
    hint: 'Deletes all current decks, cards and history, then restores the backup exactly.',
  },
];

export function Backup() {
  const decks = useLiveQuery(() => listDecks(), []);
  const settings = useLiveQuery(() => getSettings(), []);

  const fileInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [exported, setExported] = useState('');

  const [loaded, setLoaded] = useState<LoadedBackup | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [options, setOptions] = useState<ImportOptions>({
    mode: 'add',
    includeHistory: true,
    includeSettings: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ result: ImportResult; mode: ImportMode } | null>(null);

  const overdue = settings ? backupIsOverdue(settings) : false;

  async function runExport(deckIds?: string[]) {
    setBusy('export');
    setError('');
    try {
      const file = await exportBackup(deckIds);
      downloadBlob(file.blob, file.filename);
      // Only a whole-collection export counts as "backed up"; a single shared
      // deck is not a safety net for the rest.
      if (deckIds === undefined) await markBackupTaken();
      setExported(file.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function pickFile(file: File) {
    setBusy('read');
    setError('');
    setResult(null);
    try {
      const next = await readBackupFile(file);
      setLoaded(next);
      setPlan(await planImport(next, options));
    } catch (e) {
      setLoaded(null);
      setPlan(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function changeOptions(patch: Partial<ImportOptions>) {
    const next = { ...options, ...patch };
    setOptions(next);
    if (loaded) setPlan(await planImport(loaded, next));
  }

  async function runImport() {
    if (!loaded) return;
    setConfirming(false);
    setBusy('import');
    setError('');
    try {
      setResult({ result: await importBackup(loaded, options), mode: options.mode });
      setLoaded(null);
      setPlan(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  function cancelImport() {
    setLoaded(null);
    setPlan(null);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backup</h1>
          <p className="muted small">
            {cloudEnabled
              ? 'Your decks sync to your account, but sync copies mistakes too — a deletion syncs as faithfully as an edit. An export is a copy that no device can change.'
              : 'Your decks live in this browser only. An export is the one copy that survives a cleared profile, a new laptop, or a browser that decides it needs the space.'}
          </p>
        </div>
      </div>

      {error ? (
        <div className="banner banner--warn">
          <p>{error}</p>
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      ) : null}

      {result ? (
        <div className="banner">
          <p>{describeResult(result.result, result.mode)}</p>
          <button onClick={() => setResult(null)}>Dismiss</button>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}

      <section className="panel">
        <div className="setting">
          <div>
            <div className="setting__label">Export everything</div>
            <div className="setting__hint">
              Every deck, note, card, review log and setting, in one file. This is the one to keep.
              {settings?.lastBackupAt ? (
                <> Last exported {formatDate(settings.lastBackupAt)}.</>
              ) : (
                <> Never exported.</>
              )}
              {exported ? <> Saved {exported}.</> : null}
            </div>
          </div>
          <div className="setting__control">
            <button
              className={overdue ? 'primary' : ''}
              disabled={busy !== ''}
              onClick={() => void runExport()}
            >
              {busy === 'export' ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>

        <div className="setting">
          <div>
            <div className="setting__label">Export one deck</div>
            <div className="setting__hint">
              A shareable file with that deck&rsquo;s notes and scheduling, without your settings.
            </div>
          </div>
          <div className="setting__control">
            <select
              defaultValue=""
              disabled={busy !== '' || !decks?.length}
              onChange={(e) => {
                if (e.target.value) void runExport([e.target.value]);
                e.target.value = '';
              }}
            >
              <option value="">{decks?.length ? 'Choose a deck…' : 'No decks yet'}</option>
              {decks?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}

      <h2 style={{ margin: '1.75rem 0 0.6rem' }}>Import</h2>

      <section className="panel">
        <div className="setting">
          <div>
            <div className="setting__label">Choose a backup file</div>
            <div className="setting__hint">
              A .json or .zip exported from Cloze. Nothing is written until you confirm.
            </div>
          </div>
          <div className="setting__control">
            <input
              ref={fileInput}
              id="backup-file"
              type="file"
              accept=".json,.zip,application/json,application/zip"
              disabled={busy !== ''}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void pickFile(file);
              }}
            />
          </div>
        </div>

        {plan && loaded ? (
          <>
            <div className="import-plan">
              <div className="import-plan__grid">
                <Stat n={plan.decks} label="decks" />
                <Stat n={plan.notes} label="notes" />
                <Stat n={plan.cards} label="cards" />
                <Stat n={plan.reviewLogs} label="reviews" />
                {plan.media ? <Stat n={plan.media} label="images" /> : null}
              </div>
              <p className="small faint">
                Exported {formatDate(plan.exportedAt)} · {loaded.container.toUpperCase()}
                {plan.upgradedFrom !== undefined
                  ? ` · upgraded from format ${plan.upgradedFrom}`
                  : ''}
              </p>

              {plan.collidingDeckNames.length ? (
                <p className="small">
                  {options.mode === 'merge' ? 'Will merge into' : 'Deck names already here'}:{' '}
                  {plan.collidingDeckNames.join(', ')}
                  {options.mode === 'add' ? ' — imported copies will be renamed.' : '.'}
                </p>
              ) : null}
              {options.mode === 'merge' && plan.duplicates ? (
                <p className="small">
                  {plan.duplicates} note{plan.duplicates === 1 ? '' : 's'} already exist and will be
                  skipped.
                </p>
              ) : null}
              {plan.invalidCards ? (
                <p className="small">
                  {plan.invalidCards} card{plan.invalidCards === 1 ? '' : 's'} have damaged
                  scheduling data and will be reset to new.
                </p>
              ) : null}
            </div>

            <fieldset className="modes">
              <legend className="sr-only">Import mode</legend>
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className={`mode${options.mode === m.value ? ' mode--on' : ''}${
                    m.value === 'restore' ? ' mode--danger' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="import-mode"
                    value={m.value}
                    checked={options.mode === m.value}
                    onChange={() => void changeOptions({ mode: m.value })}
                  />
                  <span>
                    <span className="mode__label">{m.label}</span>
                    <span className="mode__hint">{m.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="setting">
              <div>
                <div className="setting__label">Keep scheduling history</div>
                <div className="setting__hint">
                  Off imports the material as brand-new cards. Turn it off for a deck someone else
                  made — their review history says nothing about your memory.
                </div>
              </div>
              <div className="setting__control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={options.includeHistory}
                    onChange={(e) => void changeOptions({ includeHistory: e.target.checked })}
                  />
                  <span>{options.includeHistory ? 'Keeping' : 'Discarding'}</span>
                </label>
              </div>
            </div>

            {options.mode === 'restore' ? (
              <div className="setting">
                <div>
                  <div className="setting__label">Also restore settings</div>
                  <div className="setting__hint">
                    Theme, rollover hour, daily limits and FSRS parameters from the backup.
                  </div>
                </div>
                <div className="setting__control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={options.includeSettings}
                      onChange={(e) => void changeOptions({ includeSettings: e.target.checked })}
                    />
                    <span>{options.includeSettings ? 'Yes' : 'No'}</span>
                  </label>
                </div>
              </div>
            ) : null}

            <div className="row" style={{ justifyContent: 'flex-end', paddingTop: '0.8rem' }}>
              <button onClick={cancelImport}>Cancel</button>
              <button
                className={options.mode === 'restore' ? 'danger' : 'primary'}
                disabled={busy !== ''}
                onClick={() => (options.mode === 'restore' ? setConfirming(true) : void runImport())}
              >
                {busy === 'import'
                  ? 'Importing…'
                  : options.mode === 'restore'
                    ? 'Replace everything'
                    : 'Import'}
              </button>
            </div>
          </>
        ) : null}
      </section>

      <Dialog
        open={confirming}
        title="Replace everything?"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger" onClick={() => void runImport()}>
              Delete and restore
            </button>
          </>
        }
      >
        <p className="small">
          This deletes all {decks?.length ?? 0} current deck{decks?.length === 1 ? '' : 's'} and
          every card and review in them, then restores the backup. It cannot be undone.
          {cloudEnabled ? ' With sync on, the deletion reaches every device signed in to your account.' : ''}
        </p>
        <p className="small muted">Export first if there is anything here worth keeping.</p>
      </Dialog>
    </>
  );
}

/**
 * Report what happened in the terms of the mode that was chosen. "1 new deck"
 * after a restore reads as though something was added to what was there, which
 * is the opposite of what a restore did.
 */
function describeResult(r: ImportResult, mode: ImportMode): string {
  const parts: string[] = [];

  if (mode === 'restore') {
    parts.push(
      `Restored ${plural(r.decksCreated, 'deck')}, ${plural(r.notesImported, 'note')} and ${plural(r.cardsImported, 'card')}`,
    );
  } else {
    parts.push(`Imported ${plural(r.notesImported, 'note')} and ${plural(r.cardsImported, 'card')}`);
    if (r.decksCreated) parts.push(`${plural(r.decksCreated, 'new deck')}`);
    if (r.decksMerged) parts.push(`merged into ${plural(r.decksMerged, 'existing deck')}`);
  }

  if (r.reviewLogsImported) parts.push(`${plural(r.reviewLogsImported, 'review')} of history`);
  if (r.mediaImported) parts.push(`${plural(r.mediaImported, 'image')}`);

  let text = parts.join(', ');
  if (r.notesSkipped) text += ` · ${plural(r.notesSkipped, 'duplicate')} skipped`;
  if (r.cardsReset) {
    text += ` · ${plural(r.cardsReset, 'card')} reset (damaged scheduling data)`;
  }
  return `${text}.`;
}
