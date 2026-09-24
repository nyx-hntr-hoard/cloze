/**
 * Renders the cloze engine's segment output.
 *
 * The engine deliberately returns data rather than markup, so this is the only
 * place that decides what a blank or a revealed answer looks like. Both the
 * editor preview and the review screen (phase 4) draw through here, which is
 * what keeps authoring and studying visually identical.
 */

import { Fragment } from 'react';
import type { Segment } from '../cloze';
import { MediaEmbed } from './MediaEmbed';

/** Shown inside a blank when the author gave no hint. */
const BLANK_MARK = '[…]';

export function SegmentView({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'text':
            // Note text is whitespace-significant: authors write lists and
            // indented command output, so newlines have to survive.
            return <Fragment key={i}>{seg.text}</Fragment>;

          case 'blank':
            return (
              <span key={i} className={`cz-blank${seg.hint ? ' cz-blank--hinted' : ''}`}>
                {seg.hint ?? BLANK_MARK}
              </span>
            );

          case 'reveal':
            return (
              <span key={i} className="cz-reveal">
                {seg.text}
              </span>
            );

          case 'context':
            return (
              <span key={i} className="cz-context">
                {seg.text}
              </span>
            );

          case 'media':
            // Keyed by id as well as position: if editing swaps which media
            // sits at this spot, React remounts a fresh MediaEmbed instead of
            // reusing one whose in-flight load was for the old id.
            return <MediaEmbed key={`${i}:${seg.id}`} id={seg.id} alt={seg.alt} />;

          case 'divider':
            // The back of a basic card: question above, answer below.
            return <hr key={i} className="cz-divider" />;
        }
      })}
    </>
  );
}
