/**
 * Renders a stored media blob — image or audio, whichever it turns out to be.
 *
 * A cloze/basic field only stores a `media:<id>` reference; the byte's mime
 * type lives with the stored blob, not the markup, so this component asks the
 * repository for both together and picks the tag once the lookup resolves.
 *
 * Object URLs are acquired and released through the repository's ref-counted
 * cache rather than minted per render: a review session that creates a fresh
 * blob URL on every keystroke leaks memory for as long as the tab is open.
 */

import { useEffect, useState } from 'react';
import { acquireObjectUrl, releaseObjectUrl } from '../repo';

export function MediaEmbed({ id, alt }: { id: string; alt: string }) {
  const [state, setState] = useState<{ url: string; mime: string } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    void acquireObjectUrl(id).then((next) => {
      if (!live) {
        // Unmounted while loading — hand the reference straight back.
        if (next) releaseObjectUrl(id);
        return;
      }
      if (next) setState(next);
      else setMissing(true);
    });

    return () => {
      live = false;
      releaseObjectUrl(id);
    };
  }, [id]);

  if (missing) {
    return (
      <span className="media-missing" title={`Missing media ${id}`}>
        {alt || 'missing media'}
      </span>
    );
  }
  if (!state) return <span className="media-loading" aria-hidden="true" />;

  if (state.mime.startsWith('audio/')) {
    return <audio className="media-audio" controls src={state.url} aria-label={alt || 'audio clip'} />;
  }
  return <img className="media-image" src={state.url} alt={alt} />;
}
