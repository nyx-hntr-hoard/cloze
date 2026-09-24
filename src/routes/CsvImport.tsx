/**
 * CSV import.
 *
 * An arbitrary spreadsheet has arbitrary headers, so this is a three-step
 * conversation rather than a file picker that just works: pick the note type
 * for the whole file (mixing cloze and basic per row would multiply the UI
 * for a case bulk import rarely needs — Anki's own CSV importer works the
 * same way), map each column to a field, and see the result on real rows
 * before committing. Nothing is written until "Import" is pressed.
 */

import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  fieldsFor,
  guessMapping,
  importCsv,
  mapRows,
  parseCsv,
  planCsvImport,
  type ColumnField,
  type CsvImportResult,
} from '../csv';
import type { NoteType } from '../notetypes';
import { getDeck } from '../repo';
import { plural, truncate } from '../lib/text';
import { Stat } from '../ui/Stat';

function headerFrom(rows: string[][], hasHeader: boolean): string[] {
  const width = rows[0]?.length ?? 0;
  return hasHeader ? rows[0] : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
}

function describeResult(r: CsvImportResult): string {
  const parts = [`Imported ${plural(r.notesImported, 'note')} and ${plural(r.cardsImported, 'card')}`];
  if (r.blankSkipped) parts.push(`${plural(r.blankSkipped, 'blank row')} skipped`);
  if (r.duplicatesSkipped) parts.push(`${plural(r.duplicatesSkipped, 'duplicate')} skipped`);
  let text = parts.join(' · ');
  if (r.noCards) text += ` · ${plural(r.noCards, 'note')} generated no cards`;
  return `${text}.`;
}

export function CsvImport() {
  const { deckId = '' } = useParams();
  const navigate = useNavigate();
  const deck = useLiveQuery(async () => (await getDeck(deckId)) ?? null, [deckId]);

  const fileInput = useRef<HTMLInputElement>(null);

  const [rawRows, setRawRows] = useState<string[][] | null>(null);
  const [filename, setFilename] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [noteType, setNoteType] = useState<NoteType>('basic');
  const [mapping, setMapping] = useState<ColumnField[]>([]);
  const [defaultReverse, setDefaultReverse] = useState(false);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<CsvImportResult | null>(null);

  const header = useMemo(() => (rawRows ? headerFrom(rawRows, hasHeader) : []), [rawRows, hasHeader]);
  const dataRows = useMemo(
    () => (rawRows ? (hasHeader ? rawRows.slice(1) : rawRows) : []),
    [rawRows, hasHeader],
  );
  const mappedRows = useMemo(
    () => mapRows(dataRows, { type: noteType, mapping, defaultReverse }),
    [dataRows, noteType, mapping, defaultReverse],
  );

  const plan = useLiveQuery(
    () => (mappedRows.length ? planCsvImport(deckId, noteType, mappedRows, skipDuplicates) : null),
    [deckId, noteType, skipDuplicates, mappedRows],
  );

  async function pickFile(file: File) {
    setBusy('read');
    setError('');
    setResult(null);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) throw new Error('That file has no rows.');
      setRawRows(rows);
      setFilename(file.name);
      setMapping(guessMapping(headerFrom(rows, hasHeader), noteType));
    } catch (e) {
      setRawRows(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  function changeHeader(checked: boolean) {
    setHasHeader(checked);
    if (rawRows) setMapping(guessMapping(headerFrom(rawRows, checked), noteType));
  }

  function changeType(type: NoteType) {
    setNoteType(type);
    if (rawRows) setMapping(guessMapping(headerFrom(rawRows, hasHeader), type));
  }

  function changeColumn(i: number, field: ColumnField) {
    setMapping((m) => m.map((f, idx) => (idx === i ? field : f)));
  }

  function reset() {
    setRawRows(null);
    setFilename('');
    setError('');
    if (fileInput.current) fileInput.current.value = '';
  }

  async function commit() {
    setBusy('import');
    setError('');
    try {
      const res = await importCsv(deckId, noteType, mappedRows, skipDuplicates);
      setResult(res);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
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

  const fields = fieldsFor(noteType);
  const hasTextCol = mapping.includes('text');
  const hasBackCol = mapping.includes('back');
  const missingField = !hasTextCol
    ? noteType === 'basic'
      ? 'Front'
      : 'Text'
    : noteType === 'basic' && !hasBackCol
      ? 'Back'
      : null;
  const previewMapped = mappedRows.slice(0, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small faint">
            <Link to="/">Decks</Link> / <Link to={`/deck/${deckId}`}>{deck.name}</Link>
          </p>
          <h1>Import CSV</h1>
          <p className="muted small">
            Bulk-add notes from a spreadsheet. This carries text, extra and tags — no scheduling
            state, no media, one note type per file. For a full copy with history and mixed types,
            use <Link to="/backup">Backup</Link> instead.
          </p>
        </div>
        <button onClick={() => navigate(`/deck/${deckId}`)}>Done</button>
      </div>

      {error ? (
        <div className="banner banner--warn">
          <p>{error}</p>
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      ) : null}

      {result ? (
        <div className="banner">
          <p>{describeResult(result)}</p>
          <button onClick={() => setResult(null)}>Dismiss</button>
        </div>
      ) : null}

      <section className="panel">
        <div className="setting">
          <div>
            <div className="setting__label">Choose a CSV file</div>
            <div className="setting__hint">
              Any spreadsheet export will do — its columns get mapped to fields next.
            </div>
          </div>
          <div className="setting__control">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={busy !== ''}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void pickFile(file);
              }}
            />
          </div>
        </div>

        {rawRows ? (
          <>
            <div className="setting">
              <div>
                <div className="setting__label">First row is column headers</div>
                <div className="setting__hint">{filename}</div>
              </div>
              <div className="setting__control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={hasHeader}
                    onChange={(e) => changeHeader(e.target.checked)}
                  />
                  <span>{hasHeader ? 'Yes' : 'No'}</span>
                </label>
              </div>
            </div>

            <div className="setting">
              <div>
                <div className="setting__label">Note type</div>
                <div className="setting__hint">
                  One type for the whole file — {plural(dataRows.length, 'row')} of data.
                </div>
              </div>
              <div className="setting__control">
                <div className="typeswitch" role="group" aria-label="Note type">
                  <button
                    type="button"
                    className={noteType === 'cloze' ? 'on' : ''}
                    onClick={() => changeType('cloze')}
                  >
                    Cloze
                  </button>
                  <button
                    type="button"
                    className={noteType === 'basic' ? 'on' : ''}
                    onClick={() => changeType('basic')}
                  >
                    Basic
                  </button>
                </div>
              </div>
            </div>

            {noteType === 'basic' && !mapping.includes('reverse') ? (
              <div className="setting">
                <div>
                  <div className="setting__label">Also add the reverse card</div>
                  <div className="setting__hint">
                    Applies to every row, since no column here is mapped to Reverse.
                  </div>
                </div>
                <div className="setting__control">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={defaultReverse}
                      onChange={(e) => setDefaultReverse(e.target.checked)}
                    />
                    <span>{defaultReverse ? 'Yes' : 'No'}</span>
                  </label>
                </div>
              </div>
            ) : null}

            <div className="setting">
              <div>
                <div className="setting__label">Skip duplicates</div>
                <div className="setting__hint">
                  Skip a row whose note already exists in this deck, or repeats earlier in the file.
                </div>
              </div>
              <div className="setting__control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                  />
                  <span>{skipDuplicates ? 'Skipping' : 'Importing all'}</span>
                </label>
              </div>
            </div>

            <h2 className="csv-subhead">Map columns</h2>
            <table className="csvmap">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Example</th>
                  <th>Field</th>
                </tr>
              </thead>
              <tbody>
                {header.map((h, i) => (
                  <tr key={i}>
                    <td>{h || `Column ${i + 1}`}</td>
                    <td className="faint">{truncate(dataRows[0]?.[i] ?? '', 40)}</td>
                    <td>
                      <select
                        value={mapping[i] ?? 'ignore'}
                        onChange={(e) => changeColumn(i, e.target.value as ColumnField)}
                      >
                        {fields.map((f) => (
                          <option key={f.field} value={f.field}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {missingField ? (
              <p className="small field-error">Map a column to {missingField} to continue.</p>
            ) : null}

            {plan ? (
              <div className="import-plan">
                <div className="import-plan__grid">
                  <Stat n={plan.totalRows} label="rows" />
                  <Stat n={plan.toImport} label="will import" />
                  <Stat n={plan.blank} label="blank, skipped" />
                  <Stat n={plan.duplicates} label="duplicate, skipped" />
                </div>
              </div>
            ) : null}

            <h2 className="csv-subhead">Preview</h2>
            <table className="csvmap csvmap--preview">
              <thead>
                <tr>
                  <th>{noteType === 'basic' ? 'Front' : 'Text'}</th>
                  {noteType === 'basic' ? <th>Back</th> : null}
                  <th>Extra</th>
                  <th>Tags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {previewMapped.map((row) => (
                  <tr key={row.index} className={row.blank ? 'csvmap__row--blank' : ''}>
                    <td>{truncate(row.text, 60)}</td>
                    {noteType === 'basic' ? <td>{truncate(row.back, 60)}</td> : null}
                    <td className="faint">{truncate(row.extra, 40)}</td>
                    <td className="faint">{row.tags.join(' ')}</td>
                    <td className="small faint">{row.blank ? 'blank' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dataRows.length > previewMapped.length ? (
              <p className="small faint">
                showing {previewMapped.length} of {dataRows.length} rows
              </p>
            ) : null}

            <div className="row" style={{ justifyContent: 'flex-end', paddingTop: '0.8rem' }}>
              <button onClick={reset}>Cancel</button>
              <button
                className="primary"
                disabled={busy !== '' || missingField !== null || !plan || plan.toImport === 0}
                onClick={() => void commit()}
              >
                {busy === 'import' ? 'Importing…' : plan ? `Import ${plan.toImport}` : 'Import'}
              </button>
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
