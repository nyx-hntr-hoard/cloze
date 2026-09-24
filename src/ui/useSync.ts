/**
 * Sync state for the UI: who's signed in and what the sync engine is doing.
 * Returns `null` when this build doesn't sync, so callers render nothing.
 */

import { useObservable } from 'dexie-react-hooks';
import type { SyncState, UserLogin } from 'dexie-cloud-addon';
import { db } from '../db/db';
import { cloudEnabled } from '../db/cloud';

export interface SyncView {
  user: UserLogin | undefined;
  state: SyncState | undefined;
}

/** Only call inside a component rendered when `cloudEnabled` — hooks can't be conditional. */
function useSyncObservables(): SyncView {
  const user = useObservable(db.cloud.currentUser);
  const state = useObservable(db.cloud.syncState);
  return { user, state };
}

export const useSync: () => SyncView | null = cloudEnabled ? useSyncObservables : () => null;

export type SyncTone = 'ok' | 'busy' | 'off' | 'error';

/** A short human label plus a tone for the status dot. Never color alone: the label always travels with it. */
export function describeSync(state: SyncState | undefined): { label: string; tone: SyncTone } {
  if (!state) return { label: 'Starting…', tone: 'busy' };
  if (state.license === 'expired' || state.license === 'deactivated') {
    return { label: 'Sync license ' + state.license, tone: 'error' };
  }
  switch (state.phase) {
    case 'in-sync':
      return { label: 'Synced', tone: 'ok' };
    case 'pushing':
    case 'pulling':
    case 'initial':
    case 'not-in-sync':
      return { label: 'Syncing…', tone: 'busy' };
    case 'offline':
      return { label: 'Offline — changes are saved and will sync', tone: 'off' };
    case 'error':
      return { label: `Sync error${state.error?.message ? `: ${state.error.message}` : ''}`, tone: 'error' };
    default:
      return { label: state.status, tone: 'busy' };
  }
}
