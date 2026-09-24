/**
 * Tag entry as chips.
 *
 * Enter, comma and space all commit a tag, because all three are what people
 * reach for. Backspace on an empty field removes the last chip.
 */

import { useState, type KeyboardEvent } from 'react';

export interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Tags already used in this deck, offered as suggestions. */
  suggestions?: string[];
  id?: string;
}

function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').replace(/^#+/, '');
}

export function TagInput({ tags, onChange, suggestions = [], id }: TagInputProps) {
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const tag = normalize(raw);
    if (!tag) return;
    if (!tags.includes(tag)) onChange([...tags, tag]);
    setDraft('');
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || (e.key === ' ' && draft.trim())) {
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === 'Backspace' && draft === '' && tags.length) {
      e.preventDefault();
      remove(tags[tags.length - 1]);
    }
  }

  const unused = suggestions.filter((s) => !tags.includes(s)).slice(0, 8);

  return (
    <div className="taginput">
      <div className="taginput__field">
        {tags.map((tag) => (
          <span key={tag} className="chip">
            {tag}
            <button
              type="button"
              className="chip__x"
              aria-label={`Remove tag ${tag}`}
              onClick={() => remove(tag)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="taginput__input"
          value={draft}
          placeholder={tags.length ? '' : 'Add tags…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
        />
      </div>
      {unused.length ? (
        <div className="taginput__suggest">
          {unused.map((s) => (
            <button key={s} type="button" className="chip chip--ghost" onClick={() => commit(s)}>
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
