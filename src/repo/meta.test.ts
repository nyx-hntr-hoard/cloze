import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensureMeta } from '../db/db';
import { META_KEY, PROFILE_FSRS_ID, PROFILE_SETTINGS_ID } from '../db/types';
import { getFsrsParams, getSettings, updateFsrsParams, updateSettings } from './meta';

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureMeta();
});

describe('settings split between device and sync', () => {
  it('routes synced keys to the profile table and device keys to meta', async () => {
    await updateSettings({ rolloverHour: 6, theme: 'dark' });
    const profile = await db.profile.get(PROFILE_SETTINGS_ID);
    expect(profile!.settings).toEqual({ rolloverHour: 6, backupReminderDays: 7 });
    expect('theme' in profile!.settings!).toBe(false);
    expect((await db.meta.get(META_KEY))!.settings.theme).toBe('dark');
    expect(await getSettings()).toMatchObject({ rolloverHour: 6, theme: 'dark' });
  });

  it('a device-only change makes no synced write', async () => {
    await updateSettings({ theme: 'light' });
    expect(await db.profile.get(PROFILE_SETTINGS_ID)).toBeUndefined();
  });

  it('falls back to settings stored in meta before the profile table existed', async () => {
    await db.meta.update(META_KEY, {
      settings: { theme: 'system', rolloverHour: 2, backupReminderDays: 3 },
      fsrsParams: { ...(await getFsrsParams()), requestRetention: 0.85 },
    });
    expect(await getSettings()).toMatchObject({ rolloverHour: 2, backupReminderDays: 3 });
    expect((await getFsrsParams()).requestRetention).toBe(0.85);
  });

  it('synced values win over the local fallback — they are what another device wrote', async () => {
    await db.meta.update(META_KEY, { settings: { theme: 'system', rolloverHour: 2, backupReminderDays: 7 } });
    await db.profile.put({ id: PROFILE_SETTINGS_ID, settings: { rolloverHour: 5 }, modified: 1 });
    expect((await getSettings()).rolloverHour).toBe(5);
  });

  it('FSRS params and settings live in separate rows, so writing one never touches the other', async () => {
    await updateSettings({ rolloverHour: 3 });
    const before = await db.profile.get(PROFILE_SETTINGS_ID);
    await updateFsrsParams({ requestRetention: 0.8 });
    expect(await db.profile.get(PROFILE_SETTINGS_ID)).toEqual(before);
    expect((await db.profile.get(PROFILE_FSRS_ID))!.fsrsParams!.requestRetention).toBe(0.8);
    expect((await getFsrsParams()).requestRetention).toBe(0.8);
  });
});
