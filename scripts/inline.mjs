/**
 * Fold the built app into one self-contained HTML file.
 *
 * Why this exists: a normal Vite build loads its JS as an ES module from a
 * separate file, and browsers block that over `file://` as a cross-origin
 * request. So `dist/index.html` opened by double-clicking renders a blank page.
 * With the script and stylesheet inlined there is nothing to fetch, and the app
 * runs straight off the filesystem — no server, no install, no build tools.
 *
 * That matters because it is the only way to run this app on a machine where
 * you cannot install or execute anything: one file, opened in a browser.
 *
 * Verified in Chromium: IndexedDB works over `file://`, survives reloads, and
 * follows the file when it is renamed or moved to another folder — Chromium
 * gives every `file://` page the same origin. Two consequences of that, both
 * worth knowing:
 *
 *  - Any other local HTML file you open in that browser shares this storage.
 *    On a shared or untrusted machine, prefer a real origin (http://localhost
 *    or a hosted URL) over `file://`.
 *  - `navigator.storage.persist()` is refused over `file://`, so storage is
 *    always best-effort and evictable there. The backup screen is not optional.
 *
 * Other browsers scope `file://` origins differently, so decks will not carry
 * over between them. Export first.
 *
 * Usage: node scripts/inline.mjs   (or `npm run build:single`, which builds first)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const outFile = resolve(process.argv[3] ?? join(dist, 'cloze.html'));

const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`No ${indexPath}. Run "npm run build" first.`);
  process.exit(1);
}

let html = readFileSync(indexPath, 'utf8');

/** Resolve an href/src from index.html to a path inside dist. */
const localPath = (ref) => join(dist, ref.replace(/^\.?\//, ''));

// --- stylesheet -----------------------------------------------------------
html = html.replace(
  /<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
  (whole, href) => {
    const file = localPath(href);
    if (!existsSync(file)) return whole;
    return `<style>\n${readFileSync(file, 'utf8')}\n</style>`;
  },
);

// --- scripts --------------------------------------------------------------
html = html.replace(
  /<script([^>]*)src="([^"]+)"([^>]*)><\/script>/g,
  (whole, before, src, after) => {
    const file = localPath(src);
    if (!existsSync(file)) return whole;
    const attrs = `${before}${after}`.replace(/\s*crossorigin\s*/g, ' ').trim();
    // `</script>` anywhere in the bundle would close the tag early.
    const code = readFileSync(file, 'utf8').replace(/<\/script>/gi, '<\\/script>');
    return `<script ${attrs}>\n${code}\n</script>`;
  },
);

// --- favicon --------------------------------------------------------------
// Left as a separate request it would 404 noisily over file://.
html = html.replace(/<link[^>]+rel="icon"[^>]*href="([^"]+)"[^>]*>/g, (whole, href) => {
  const file = localPath(href);
  if (!existsSync(file)) return whole;
  const data = readFileSync(file).toString('base64');
  const type = href.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  return `<link rel="icon" type="${type}" href="data:${type};base64,${data}" />`;
});

writeFileSync(outFile, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote ${outFile} (${kb} KB)`);

// A leftover reference means something did not get inlined, and the file will
// break as soon as it is moved away from dist/. Only the markup is checked —
// the bundle is full of strings that look like attributes but are not.
const markupOnly = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');

const dangling = [...markupOnly.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map(
  (m) => m[1],
);
if (dangling.length) {
  console.error(`Not self-contained — still references: ${dangling.join(', ')}`);
  process.exit(1);
}
