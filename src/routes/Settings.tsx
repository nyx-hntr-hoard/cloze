import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  auditMedia,
  backupIsOverdue,
  deleteMedia,
  getSettings,
  requestPersistentStorage,
  storageEstimate,
  updateSettings,
  type MediaAudit,
} from '../repo';
import { applyTheme } from '../ui/useTheme';
import { formatDate } from '../lib/time';
import { plural } from '../lib/text';
import { SchedulingPanel } from '../ui/SchedulingPanel';
import { SyncPanel } from '../ui/SyncPanel';
import { cloudEnabled } from '../db/cloud';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function Settings() {
  const settings = useLiveQuery(() => getSettings(), []);

  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);

  // Re-runs whenever `db.notes` or `db.media` changes, so deleting the
  // orphans below (or attaching new media elsewhere) updates this without a
  // manual refetch.
  const audit: MediaAudit | undefined = useLiveQuery(() => auditMedia(), []);
  const [deletingOrphans, setDeletingOrphans] = useState(false);
  const [mediaError, setMediaError] = useState('');

  async function deleteOrphans() {
    if (!audit || audit.orphans.length === 0) return;
    setDeletingOrphans(true);
    setMediaError('');
    try {
      await deleteMedia(audit.orphans.map((m) => m.id));
    } catch (e) {
      setMediaError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingOrphans(false);
    }
  }

  useEffect(() => {
    void storageEstimate().then(setEstimate);
    // `null` is already the initial value, meaning "the browser doesn't say",
    // so the unsupported branch needs no state update.
    void navigator.storage?.persisted?.()
      .then(setPersisted)
      .catch(() => undefined);
  }, []);

  async function askForPersistence() {
    setAsking(true);
    const granted = await requestPersistentStorage();
    setPersisted(granted);
    await updateSettings({ storagePersisted: granted });
    setAsking(false);
  }

  if (!settings) return null;

  const overdue = backupIsOverdue(settings);
  const usedPct = estimate && estimate.quota ? (estimate.usage / estimate.quota) * 100 : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted small">
            {cloudEnabled
              ? 'Theme and storage are this device’s; everything else syncs with your account.'
              : 'Everything here is stored locally, in this browser.'}
          </p>
        </div>
      </div>

      {persisted === false ? (
        <div className="banner banner--warn">
          <p>
            Storage is evictable. The browser may clear your decks under storage pressure. Granting
            persistent storage prevents that.
          </p>
          <button className="primary" onClick={askForPersistence} disabled={asking}>
            {asking ? 'Asking…' : 'Grant'}
          </button>
        </div>
      ) : null}

      {overdue ? (
        <div className="banner">
          <p>
            {settings.lastBackupAt
              ? `Last backup ${formatDate(settings.lastBackupAt)}.`
              : 'You have never exported a backup.'}{' '}
            Browser storage is not a backup.
          </p>
          <Link className="button primary" to="/backup">
            Export
          </Link>
        </div>
      ) : null}

      <div className="panel">
        <div className="setting">
          <div>
            <div className="setting__label">Theme</div>
            <div className="setting__hint">Follow the system setting or pin one.</div>
          </div>
          <div className="setting__control">
            <select
              value={settings.theme}
              onChange={(e) => {
                const theme = e.target.value as typeof settings.theme;
                applyTheme(theme);
                void updateSettings({ theme });
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>

        <div className="setting">
          <div>
            <div className="setting__label">Day starts at</div>
            <div className="setting__hint">
              Reviews before this hour count toward the previous day, so a late session doesn't break
              a streak. Decks can override it.
            </div>
          </div>
          <div className="setting__control">
            <select
              value={settings.rolloverHour}
              onChange={(e) => void updateSettings({ rolloverHour: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="setting">
          <div>
            <div className="setting__label">Backup reminder</div>
            <div className="setting__hint">
              Nag after this many days without an export. Set to 0 to turn it off.
            </div>
          </div>
          <div className="setting__control">
            <input
              type="number"
              min={0}
              value={settings.backupReminderDays}
              onChange={(e) =>
                void updateSettings({ backupReminderDays: Number(e.target.value) || 0 })
              }
            />
          </div>
        </div>

        <div className="setting">
          <div>
            <div className="setting__label">Storage</div>
            <div className="setting__hint">
              {persisted === true
                ? 'Persistent — the browser will not evict this data automatically.'
                : persisted === false
                  ? 'Best-effort — the browser may evict this data.'
                  : 'This browser does not report a persistence state.'}
              {estimate ? (
                <>
                  {' '}
                  Using {formatBytes(estimate.usage)}
                  {estimate.quota ? ` of ${formatBytes(estimate.quota)}` : ''}.
                  <div className="meter">
                    <div className="meter__fill" style={{ width: `${Math.min(100, usedPct)}%` }} />
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div className="setting__control">
            <button onClick={askForPersistence} disabled={asking || persisted === true}>
              {persisted === true ? 'Granted' : asking ? 'Asking…' : 'Request persistence'}
            </button>
          </div>
        </div>

        <div className="setting">
          <div>
            <div className="setting__label">Media</div>
            <div className="setting__hint">
              Images and audio attached to notes.{' '}
              {audit ? (
                <>
                  {plural(audit.totalCount, 'file')} stored, {formatBytes(audit.totalBytes)}.
                  {audit.orphans.length ? (
                    <>
                      {' '}
                      {plural(audit.orphans.length, 'file')} (
                      {formatBytes(audit.orphans.reduce((sum, m) => sum + m.size, 0))}) no note refers to
                      anymore.
                    </>
                  ) : null}
                  {audit.dangling.length ? (
                    <>
                      {' '}
                      {plural(audit.dangling.length, 'reference')} to media that's missing — those cards
                      show a broken-media marker.
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
            {mediaError ? <p className="field-error">{mediaError}</p> : null}
          </div>
          <div className="setting__control">
            <button
              className={audit && audit.orphans.length > 0 ? 'danger' : ''}
              onClick={() => void deleteOrphans()}
              disabled={!audit || audit.orphans.length === 0 || deletingOrphans}
              title="Deletes only blobs no live note refers to. Referenced media, and review history, are untouched."
            >
              {deletingOrphans
                ? 'Deleting…'
                : audit && audit.orphans.length > 0
                  ? `Delete ${plural(audit.orphans.length, 'orphan')}`
                  : 'No orphans'}
            </button>
          </div>
        </div>
      </div>

      <SyncPanel />
      <SchedulingPanel />
    </>
  );
}
