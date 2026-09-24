/**
 * Whether this build syncs, and where to.
 *
 * Sync is opt-in at build time: set `VITE_DEXIE_CLOUD_URL` (in `.env.local`
 * for development, or as a repository variable for the Pages deploy) and the
 * app signs in to that Dexie Cloud database. Leave it unset and the app is
 * exactly the local-only app it has always been — no add-on activated, no
 * network calls.
 *
 * A page opened from `file://` never syncs: Dexie Cloud only talks to origins
 * you've whitelisted, and a file has no origin to whitelist. The standalone
 * `cloze.html` is built local-only anyway (see `vite.config.ts`); this guard
 * covers anything else opened from disk.
 */

const configured = (import.meta.env.VITE_DEXIE_CLOUD_URL ?? '').trim();
const onFile = typeof location !== 'undefined' && location.protocol === 'file:';

/** The database URL in use, or empty when sync is off. */
export const CLOUD_URL = configured && !onFile ? configured : '';

export const cloudEnabled = CLOUD_URL !== '';
