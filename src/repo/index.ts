/**
 * The persistence boundary.
 *
 * Components import from here, never from `src/db`. Keeping every Dexie call
 * behind this barrel is what makes a later swap — File System Access API so
 * decks are real files on disk, or a sync backend — a change confined to one
 * directory rather than a rewrite of every screen.
 */

export * from './decks';
export * from './notes';
export * from './cards';
export * from './media';
export * from './bulk';
export * from './stats';
export * from './meta';

// Domain types, so a component needs exactly one import site.
export type {
  Card,
  Deck,
  DeckConfig,
  FsrsParams,
  MediaItem,
  Meta,
  Millis,
  Note,
  ReviewLog,
  Settings,
} from '../db/types';

export {
  DEFAULT_DECK_CONFIG,
  DEFAULT_FSRS_PARAMS,
  DEFAULT_SETTINGS,
} from '../db/types';

// Storage durability is a user-facing concern in a browser-only app, so it is
// part of the repository surface rather than something screens reach past it for.
export { requestPersistentStorage, storageEstimate, SCHEMA_VERSION } from '../db/db';
