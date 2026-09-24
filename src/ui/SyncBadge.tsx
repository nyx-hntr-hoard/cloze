/**
 * Top-bar sync indicator: a dot and a word, linking to the Sync panel in
 * Settings. Renders nothing in a local-only build.
 */

import { Link } from 'react-router-dom';
import { describeSync, useSync } from './useSync';

export function SyncBadge() {
  const sync = useSync();
  if (!sync) return null;
  const { label, tone } = describeSync(sync.state);
  const signedIn = !!sync.user?.isLoggedIn;
  const short = !signedIn ? 'Sign in' : tone === 'ok' ? 'Synced' : tone === 'busy' ? 'Syncing' : tone === 'off' ? 'Offline' : 'Sync error';

  return (
    <Link
      to="/settings#sync"
      className={`syncbadge syncbadge--${signedIn ? tone : 'off'}`}
      title={signedIn ? `${label}${sync.user?.email ? ` · ${sync.user.email}` : ''}` : 'Not signed in'}
    >
      <span className="syncbadge__dot" aria-hidden="true" />
      <span className="syncbadge__text">{short}</span>
    </Link>
  );
}
