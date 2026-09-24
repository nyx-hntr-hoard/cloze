/**
 * Live preview of the cards a note generates.
 *
 * Each card shows its front — what the reviewer actually sees — with the
 * answers listed underneath. Showing both at once rather than behind a toggle
 * is the point of the preview: the question you are answering while authoring
 * is "did this produce the cards I meant", and that needs the blank and its
 * answer visible together.
 *
 * It takes a draft rather than a note, so it works for anything with the shape,
 * and it renders both note types through the same path.
 */

import { splitMedia, type Diagnostic } from '../cloze';
import { cardAnswerText, renderNoteCards, type NoteLike } from '../notetypes';
import { SegmentView } from './SegmentView';

export function DiagnosticList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="diagnostics">
      {diagnostics.map((d, i) => (
        <li key={i} className={`diagnostic diagnostic--${d.severity}`}>
          <span className="diagnostic__badge">{d.severity === 'error' ? 'Error' : 'Check'}</span>
          <span>{d.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function CardPreview({ draft }: { draft: NoteLike }) {
  const cards = renderNoteCards(draft);
  const isBasic = draft.type === 'basic';

  if (cards.length === 0) {
    return (
      <div className="preview preview--empty">
        <p className="small muted">
          {isBasic
            ? 'Fill in both sides to see the card.'
            : 'Wrap some text in a cloze deletion to see the cards it generates.'}
        </p>
      </div>
    );
  }

  return (
    <div className="preview">
      {cards.map((card, index) => {
        const answer = cardAnswerText(card);
        return (
          <article key={card.ordinal} className="preview-card">
            <header className="preview-card__head">
              <span className="preview-card__ord">
                {isBasic ? (card.ordinal === 1 ? 'front → back' : 'back → front') : `c${card.ordinal}`}
              </span>
              <span className="small faint">
                Card {index + 1} of {cards.length}
              </span>
            </header>

            <div className="preview-card__front">
              <SegmentView segments={card.front} />
            </div>

            <div className={`preview-card__answer${answer ? '' : ' preview-card__answer--empty'}`}>
              <span className="preview-card__arrow" aria-hidden="true">
                →
              </span>
              <span>{answer || <span className="faint">nothing to recall</span>}</span>
            </div>

            {draft.extra?.trim() ? (
              <div className="preview-card__extra">
                <SegmentView segments={splitMedia(draft.extra ?? '')} />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
