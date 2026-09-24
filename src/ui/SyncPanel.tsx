/**
 * Settings → Sync. Who you're signed in as, what the sync engine is doing,
 * and the two actions that matter: sync now, sign out.
 *
 * In a local-only build it says so in one line and points at the README.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { db } from '../db/db';
import { CLOUD_URL, cloudEnabled } from '../db/cloud';
import { describeSync, useSync } from './useSync';

export function SyncPanel() {
  const sync = useSync();
  const { hash } = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (hash === '#sync') ref.current?.scrollIntoView({ block: 'start' });
  }, [hash]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (!cloudEnabled) {
    body = (
      <div className="setting">
        <div>
          <div className="setting__label">Off</div>
          <div className="setting__hint">
            Everything stays in this browser. To sync across devices, use a build made with a Dexie
            Cloud database URL — see “Sync” in the README. The standalone file is always local-only.
          </div>
        </div>
      </div>
    );
  } else {
    const { label, tone } = describeSync(sync?.state);
    const user = sync?.user;
    const signedIn = !!user?.isLoggedIn;
    body = (
      <>
        <div className="setting">
          <div>
            <div className="setting__label">{signedIn ? user?.email || user?.name || user?.userId : 'Not signed in'}</div>
            <div className="setting__hint">
              <span className={`syncbadge syncbadge--${signedIn ? tone : 'off'} syncbadge--inline`}>
                <span className="syncbadge__dot" aria-hidden="true" />
                <span>{signedIn ? label : 'Sign in to sync'}</span>
              </span>
              {user?.license?.type === 'eval' && user.license.evalDaysLeft !== undefined
                ? ` · evaluation account, ${user.license.evalDaysLeft} days left`
                : ''}
            </div>
            <div className="setting__hint faint small">{CLOUD_URL}</div>
          </div>
          <div className="setting__control row">
            {signedIn ? (
              <>
                <button disabled={busy} onClick={() => void act(() => db.cloud.sync({ wait: true, purpose: 'pull' }))}>
                  Sync now
                </button>
                <button className="ghost" disabled={busy} onClick={() => void act(() => db.cloud.logout())}>
                  Sign out
                </button>
              </>
            ) : (
              <button className="primary" disabled={busy} onClick={() => void act(() => db.cloud.login())}>
                Sign in
              </button>
            )}
          </div>
        </div>
        {error ? <p className="field-error">{error}</p> : null}
      </>
    );
  }

  return (
    <div className="panel" id="sync" ref={ref}>
      <h2 className="panel__title">Sync</h2>
      {body}
    </div>
  );
}
