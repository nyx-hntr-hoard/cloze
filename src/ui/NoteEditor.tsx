/**
 * The note editor, for both note types.
 *
 * Almost all of the logic lives in `src/cloze` and `src/notetypes` as pure
 * functions; this is the fields, the shortcuts and the wiring. Three decisions
 * worth knowing:
 *
 * **Shortcuts avoid Ctrl+Shift+C.** That is Anki's cloze binding, but in every
 * major browser it opens the devtools element picker before the page ever sees
 * the event, so it cannot be intercepted. `Alt+C` and `Alt+Shift+C` are free.
 *
 * **Saving is blocked on errors, not warnings.** An error means the note would
 * produce a *wrong* card — unclosed markup, a missing side. A warning means a
 * poor one, which is the author's business.
 *
 * **The type switch does not clear anything.** Switching to Basic keeps the
 * cloze text as the front, and switching back keeps the markup. Someone who
 * flips the switch to look at the other mode should not lose their work.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { nextOrdinal, sameOrdinal, wrapAsCloze } from '../cloze';
import { altFromFilename, mediaMarkdown, spliceText } from '../lib/text';
import { summarizeNote, type NoteDraft } from '../notetypes';
import { addMedia } from '../repo';
import { CardPreview, DiagnosticList } from './CardPreview';
import { TagInput } from './TagInput';

export type { NoteDraft };

export interface NoteEditorProps {
  value: NoteDraft;
  onChange: (draft: NoteDraft) => void;
  onSave: () => void | Promise<void>;
  onCancel?: () => void;
  onDelete?: () => void;
  saving?: boolean;
  /** Label for the primary button, e.g. "Add note" or "Save". */
  saveLabel: string;
  suggestions?: string[];
  /** Status line under the buttons, e.g. "3 notes added". */
  status?: string;
  autoFocus?: boolean;
}

// Only used to label a shortcut, so a rough check is enough.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

/** The three fields media can be attached to. Tags are structured, not prose. */
type FieldName = 'text' | 'back' | 'extra';

// Generous for a voice clip, stingy for a video — this is a flashcard, not a
// media library, and IndexedDB is not the place to discover that the hard way.
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

function isAttachable(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('audio/');
}

export function NoteEditor({
  value,
  onChange,
  onSave,
  onCancel,
  onDelete,
  saving = false,
  saveLabel,
  suggestions,
  status,
  autoFocus = false,
}: NoteEditorProps) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLTextAreaElement>(null);
  const extraRef = useRef<HTMLTextAreaElement>(null);
  const fieldRefs = { text: textRef, back: backRef, extra: extraRef } as const;

  /** Selection to apply after a programmatic edit, since React owns the value. */
  const pendingSelection = useRef<{ field: FieldName; range: [number, number] } | null>(null);
  /** Which field a just-picked file attaches to — captured before the file dialog steals focus. */
  const attachTarget = useRef<{ field: FieldName; range: [number, number] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState('');

  const summary = useMemo(() => summarizeNote(value), [value]);
  const isCloze = value.type === 'cloze';
  const canSave = !summary.hasError && summary.cardCount > 0 && !saving;

  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    if (!sel) return;
    const el = fieldRefs[sel.field].current;
    if (!el) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel.range[0], sel.range[1]);
  });

  /** Wrap the current selection, either as a new card or on the current one. */
  const wrap = useCallback(
    (mode: 'new' | 'same') => {
      const el = textRef.current;
      if (!el) return;
      const ordinal = mode === 'same' ? sameOrdinal(value.text) : nextOrdinal(value.text);
      const result = wrapAsCloze(value.text, el.selectionStart, el.selectionEnd, ordinal);
      pendingSelection.current = { field: 'text', range: [result.selectionStart, result.selectionEnd] };
      onChange({ ...value, text: result.text });
    },
    [onChange, value],
  );

  /** Store the blob and splice its `media:` reference into `field` at `range`. */
  const attachBlob = useCallback(
    async (field: FieldName, range: [number, number], file: File) => {
      if (!isAttachable(file.type)) {
        setAttachError('Only images and audio clips can be attached.');
        return;
      }
      if (file.size > MAX_MEDIA_BYTES) {
        setAttachError(`That file is too large to attach (max ${MAX_MEDIA_BYTES / (1024 * 1024)} MB).`);
        return;
      }
      setAttachError('');
      const item = await addMedia(file, file.name || 'media');
      const ref = mediaMarkdown(item.id, altFromFilename(item.filename));
      const current = field === 'text' ? value.text : field === 'back' ? value.back : value.extra;
      const result = spliceText(current, range[0], range[1], ref);
      pendingSelection.current = { field, range: [result.caret, result.caret] };
      onChange({ ...value, [field]: result.text });
    },
    [onChange, value],
  );

  /** Open the shared file picker for a field's attach button. */
  function openAttach(field: FieldName) {
    const el = fieldRefs[field].current;
    const range: [number, number] = el ? [el.selectionStart, el.selectionEnd] : [0, 0];
    attachTarget.current = { field, range };
    fileInputRef.current?.click();
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again later
    const target = attachTarget.current;
    attachTarget.current = null;
    if (file && target) void attachBlob(target.field, target.range, file);
  }

  /** A pasted screenshot attaches itself instead of dropping in as literal text. */
  function onPasteField(e: React.ClipboardEvent<HTMLTextAreaElement>, field: FieldName) {
    const item = Array.from(e.clipboardData.items).find(
      (i) => i.kind === 'file' && i.type.startsWith('image/'),
    );
    if (!item) return; // no image on the clipboard — let normal text paste happen
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    const el = e.currentTarget;
    void attachBlob(field, [el.selectionStart, el.selectionEnd], file);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    // Alt+C / Alt+Shift+C — see the note at the top of this file.
    if (isCloze && e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
      e.preventDefault();
      wrap(e.shiftKey ? 'same' : 'new');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canSave) void onSave();
      return;
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="editor">
      <div className="editor__pane">
        <div className="editor__toolbar">
          <div className="typeswitch" role="group" aria-label="Note type">
            {(['cloze', 'basic'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={value.type === t ? 'on' : ''}
                aria-pressed={value.type === t}
                onClick={() => onChange({ ...value, type: t })}
              >
                {t === 'cloze' ? 'Cloze' : 'Basic'}
              </button>
            ))}
          </div>

          {isCloze ? (
            <>
              <button type="button" onClick={() => wrap('new')} title="New deletion (Alt+C)">
                Blank it
              </button>
              <button
                type="button"
                onClick={() => wrap('same')}
                title="Add to the current deletion (Alt+Shift+C)"
              >
                Same card
              </button>
            </>
          ) : null}

          <span className="editor__count small">
            {summary.cardCount === 0
              ? 'no cards yet'
              : `${summary.cardCount} card${summary.cardCount === 1 ? '' : 's'}`}
          </span>
        </div>

        {isCloze ? (
          <>
            <div className="editor__field-head">
              <label htmlFor="note-text">Text</label>
              <button
                type="button"
                className="editor__attach ghost"
                onClick={() => openAttach('text')}
                title="Attach an image or audio clip"
              >
                📎 Attach
              </button>
            </div>
            <textarea
              id="note-text"
              ref={textRef}
              className="editor__text"
              value={value.text}
              autoFocus={autoFocus}
              spellCheck
              placeholder={
                'Select some text and press Alt+C to blank it.\n\nThe {{c1::capital}} of France is {{c2::Paris}}.'
              }
              onChange={(e) => onChange({ ...value, text: e.target.value })}
              onKeyDown={onKeyDown}
              onPaste={(e) => onPasteField(e, 'text')}
            />
          </>
        ) : (
          <>
            <div className="editor__field">
              <div className="editor__field-head">
                <label htmlFor="note-text">Front</label>
                <button
                  type="button"
                  className="editor__attach ghost"
                  onClick={() => openAttach('text')}
                  title="Attach an image or audio clip"
                >
                  📎 Attach
                </button>
              </div>
              <textarea
                id="note-text"
                ref={textRef}
                className="editor__side"
                value={value.text}
                autoFocus={autoFocus}
                spellCheck
                placeholder="SPN"
                onChange={(e) => onChange({ ...value, text: e.target.value })}
                onKeyDown={onKeyDown}
                onPaste={(e) => onPasteField(e, 'text')}
              />
            </div>
            <div className="editor__field">
              <div className="editor__field-head">
                <label htmlFor="note-back">Back</label>
                <button
                  type="button"
                  className="editor__attach ghost"
                  onClick={() => openAttach('back')}
                  title="Attach an image or audio clip"
                >
                  📎 Attach
                </button>
              </div>
              <textarea
                id="note-back"
                ref={backRef}
                className="editor__side"
                value={value.back}
                spellCheck
                placeholder="Service Principal Name"
                onChange={(e) => onChange({ ...value, back: e.target.value })}
                onKeyDown={onKeyDown}
                onPaste={(e) => onPasteField(e, 'back')}
              />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={value.reverse}
                onChange={(e) => onChange({ ...value, reverse: e.target.checked })}
              />
              <span>
                Also ask it backwards
                <span className="faint small"> — a second card, back to front</span>
              </span>
            </label>
          </>
        )}

        <DiagnosticList diagnostics={summary.diagnostics} />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*"
          className="sr-only"
          onChange={onFilePicked}
          tabIndex={-1}
        />
        {attachError ? (
          <div className="banner banner--warn">
            <p>{attachError}</p>
            <button type="button" onClick={() => setAttachError('')}>
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="editor__field">
          <div className="editor__field-head">
            <label htmlFor="note-extra">Extra (shown after the answer)</label>
            <button
              type="button"
              className="editor__attach ghost"
              onClick={() => openAttach('extra')}
              title="Attach an image or audio clip"
            >
              📎 Attach
            </button>
          </div>
          <textarea
            id="note-extra"
            ref={extraRef}
            className="editor__extra"
            value={value.extra}
            placeholder="Source, caveats, the full command…"
            onChange={(e) => onChange({ ...value, extra: e.target.value })}
            onKeyDown={onKeyDown}
            onPaste={(e) => onPasteField(e, 'extra')}
          />
        </div>

        <div className="editor__field">
          <label htmlFor="note-tags">Tags</label>
          <TagInput
            id="note-tags"
            tags={value.tags}
            suggestions={suggestions}
            onChange={(tags) => onChange({ ...value, tags })}
          />
        </div>

        <div className="editor__actions">
          {onDelete ? (
            <button type="button" className="danger" onClick={onDelete}>
              Delete
            </button>
          ) : null}
          <span className="editor__status small muted">{status}</span>
          {onCancel ? (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={!canSave}
            onClick={() => void onSave()}
            title={`${MOD}+Enter`}
          >
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>

      <aside className="editor__preview">
        <h2 className="editor__preview-head">Preview</h2>
        <CardPreview draft={value} />
      </aside>
    </div>
  );
}
