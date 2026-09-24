/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Your Dexie Cloud database URL, e.g. `https://zabc123.dexie.cloud`.
   * Unset (the default) builds the local-only app. See README → "Sync".
   */
  readonly VITE_DEXIE_CLOUD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
