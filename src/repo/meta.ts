/**
 * Settings and app-level metadata.
 *
 * Settings live in two places. The device-local ones (theme, storage
 * persistence) and the schema stamp stay in `meta`, which is never synced.
 * The ones that should follow you between devices (study-day rollover, the
 * backup reminder) and the FSRS parameters live in the synced `profile`
 * table. Callers don't see the split: `getSettings` merges, `updateSettings`
 * routes each key to its home.
 *
 * Read and write paths are deliberately separate. Dexie's `liveQuery` runs its
 * querier in a read-only context and throws on a readwrite transaction — which
 * is the right rule, since a query that writes would re-trigger itself forever.
 * So the getters here never create anything: they read, and fall back to
 * defaults in memory if the singleton row hasn't been written yet. Row creation
 * happens once at boot (`ensureMeta` in `main.tsx`) and again on the write path,
 * where a transaction is legal.
 */

import { db, ensureMeta, SCHEMA_VERSION } from '../db/db';
import {
  DEFAULT_FSRS_PARAMS,
  DEFAULT_SETTINGS,
  META_KEY,
  PROFILE_FSRS_ID,
  PROFILE_SETTINGS_ID,
  SYNCED_SETTING_KEYS,
  type FsrsParams,
  type Meta,
  type Settings,
  type SyncedSettings,
} from '../db/types';

// ---------------------------------------------------------------------------
// Reads — safe inside useLiveQuery
// ---------------------------------------------------------------------------

export async function getMeta(): Promise<Meta | undefined> {
  return db.meta.get(META_KEY);
}

async function syncedSettings(): Promise<Partial<SyncedSettings>> {
  return (await db.profile.get(PROFILE_SETTINGS_ID))?.settings ?? {};
}

async function syncedFsrs(): Promise<FsrsParams | undefined> {
  return (await db.profile.get(PROFILE_FSRS_ID))?.fsrsParams;
}

/** Device settings, overlaid with the synced ones once any have been written. */
export async function getSettings(): Promise<Settings> {
  const [meta, synced] = await Promise.all([db.meta.get(META_KEY), syncedSettings()]);
  return { ...DEFAULT_SETTINGS, ...meta?.settings, ...synced };
}

export async function getFsrsParams(): Promise<FsrsParams> {
  const [meta, synced] = await Promise.all([db.meta.get(META_KEY), syncedFsrs()]);
  return { ...DEFAULT_FSRS_PARAMS, ...meta?.fsrsParams, ...synced };
}

export async function getSchemaVersion(): Promise<number> {
  const meta = await db.meta.get(META_KEY);
  return meta?.schemaVersion ?? SCHEMA_VERSION;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function pickSynced(settings: Partial<Settings>): Partial<SyncedSettings> {
  const out: Partial<SyncedSettings> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    if (key in settings) (out as Record<string, unknown>)[key] = settings[key];
  }
  return out;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  await ensureMeta();
  return db.transaction('rw', db.meta, db.profile, async () => {
    const settings = { ...(await getSettings()), ...patch };
    const now = Date.now();
    // `meta` keeps a full local copy; it's what an older build would read.
    await db.meta.update(META_KEY, { settings, modified: now });
    // The synced row is written (whole — private ids only sync puts) only when
    // a synced key actually changed, so toggling the theme makes no sync traffic.
    if (Object.keys(pickSynced(patch)).length) {
      await db.profile.put({ id: PROFILE_SETTINGS_ID, settings: pickSynced(settings), modified: now });
    }
    return settings;
  });
}

export async function updateFsrsParams(patch: Partial<FsrsParams>): Promise<FsrsParams> {
  return db.transaction('rw', db.meta, db.profile, async () => {
    const fsrsParams = { ...(await getFsrsParams()), ...patch };
    await db.profile.put({ id: PROFILE_FSRS_ID, fsrsParams, modified: Date.now() });
    return fsrsParams;
  });
}

export async function markBackupTaken(at = Date.now()): Promise<void> {
  await updateSettings({ lastBackupAt: at });
}

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

/**
 * Whether to nag about a backup. Browser storage is evictable, so this is a
 * real safety feature rather than a nicety.
 */
export function backupIsOverdue(settings: Settings, now = Date.now()): boolean {
  if (!settings.backupReminderDays) return false;
  const since = now - (settings.lastBackupAt ?? 0);
  return since > settings.backupReminderDays * 86_400_000;
}
