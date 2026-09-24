/**
 * Id generation and content hashing.
 */

/** A new UUID v4. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (file:// etc). Not cryptographically
  // strong, but ids here only need to be locally unique.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Normalize note text for de-duplication: collapse whitespace, trim, casefold.
 * Deliberately *keeps* cloze markup — two notes that differ only in which
 * words are blanked are genuinely different notes.
 */
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable 64-bit FNV-1a hash of the normalized text, as 16 hex chars. */
export function hashNoteText(text: string): string {
  const s = normalizeForHash(text);
  // Two 32-bit FNV-1a passes with different offsets, concatenated.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** SHA-256 of a blob as lowercase hex. Used to de-duplicate media. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
