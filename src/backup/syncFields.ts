/**
 * Properties Dexie Cloud adds to synced rows.
 *
 * `owner` and `realmId` say which account a row belongs to; `$ts` and
 * `_hasBlobRefs` are sync-engine bookkeeping. None of them are the user's
 * data, and all of them are wrong in any other account: a backup restored
 * into someone else's (or a new) account carrying the old `realmId` would be
 * rejected by the server as a write into a realm it can't access. So a backup
 * never contains them, and an import drops them if an older file does.
 */
const SYNC_FIELDS = ['owner', 'realmId', '$ts', '_hasBlobRefs'] as const;

export function withoutSyncFields<T extends object>(row: T): T {
  if (!SYNC_FIELDS.some((f) => f in row)) return row;
  const copy = { ...row } as Record<string, unknown>;
  for (const f of SYNC_FIELDS) delete copy[f];
  return copy as T;
}
