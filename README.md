# Cloze

An offline-first cloze-deletion flashcard app. Everything lives in the
browser, and works with no network at all. Optionally, it syncs across your
devices through [Dexie Cloud](https://dexie.org/cloud/) — see [Sync](#sync).

- **Storage** — IndexedDB via Dexie; optional sync via Dexie Cloud
- **Scheduling** — FSRS v6 via `ts-fsrs`, with an optimizer that fits it to you
- **Build** — Vite + React + TypeScript, static output

Built without a sync URL (the default), it makes no network calls at runtime:
no server, no account.

## Running it

```bash
npm install
npm run dev           # dev server
npm run build         # typecheck + production build into dist/
npm run build:single  # dist/cloze.html, one self-contained file (always local-only)
npm run preview       # serve the production build
npm test              # data-layer tests (vitest + fake-indexeddb)
npm run typecheck
npm run lint
```

The build uses relative asset paths and hash routing, so `dist/` works served
from any static host or subdirectory, with no server-side rewriting.

To develop with sync on, copy `.env.example` to `.env.local` and fill in your
database URL (see [Sync](#sync)).

### Running it with no toolchain at all

`npm run build:single` writes **`dist/cloze.html`** — the whole app, about
600 KB, in one file with nothing external to fetch. Double-click it and it runs.
It's always built local-only, even with a sync URL set: a file on disk has no
origin for Dexie Cloud to whitelist, so it couldn't sign in anyway.

That file exists because a normal Vite build does *not* work from `file://`:
the bundle loads as an ES module, browsers treat that as a cross-origin request
over `file://`, and the page renders blank. With everything inlined there is
nothing to fetch.

Verified in Chromium, opened straight off the filesystem: authoring, FSRS
scheduling, the theme toggle, export downloads, import, and IndexedDB surviving
reloads — no console errors. Two caveats:

- Chromium gives every `file://` page the **same** origin. Your decks follow the
  file when you rename or move it, which is convenient — but any other local
  HTML file you open shares that storage. On a shared or untrusted machine, use
  a real origin instead.
- `navigator.storage.persist()` is refused over `file://`, so storage there is
  always best-effort. Export regularly; the reminder exists for a reason.

Other browsers scope `file://` origins differently, so decks will not carry
between them. Export first, import on the other side.

## Layout

```
src/
  notetypes.ts    NOTE TYPES — which cards a note makes and how they render
  cloze/          THE GRAMMAR — pure functions, no React, Dexie or DOM
    types.ts      AST nodes, diagnostics, render segments
    parse.ts      Tokenizer, escapes, hint splitting, diagnostics
    render.ts     AST + target ordinal -> front/back segments; media, summaries
    edit.ts       Wrap-selection, escaping, renumbering for the editor
  backup/         THE DURABILITY LAYER — export, import, format versioning
    types.ts      The backup envelope and import options
    export.ts     Collect, serialize to .json or .zip, download
    import.ts     Read, validate, remap ids and media refs, add/merge/restore
    upgrade.ts    The format upgrade chain, run on every import
    syncFields.ts Strips Dexie Cloud's owner/realmId from backups, both ways
  csv/            BULK INTERCHANGE — one deck, one note type, per file
    parse.ts      Hand-rolled CSV tokenizer (quotes, embedded newlines/commas)
    serialize.ts  The inverse: quote only when a field needs it
    mapping.ts    Column -> field mapping, header guessing, row -> note fields
    importer.ts   plan/import share one row-classification pass (blank/dup/ok)
    exporter.ts   Deck -> CSV rows, filename, downloadable blob
  browse/         SEARCH — pure, no React or Dexie
    query.ts      The search language: tokenizer, parser, warnings, globs
    search.ts     Index once per DB change, filter per keystroke, sort
  stats/          STATISTICS — history, forecast, retention, streak (pure)
  optimizer/      FSRS FITTING — pure, no React or Dexie
    dataset.ts    Review logs -> per-card (days, rating) sequences
    model.ts      FSRS-6 memory model, verified identical to ts-fsrs
    train.ts      Loss, held-out split, Adam over finite differences
    simulate.ts   A synthetic learner with known weights (tests only)
  review/         SCHEDULING — the only place that talks to ts-fsrs
    scheduler.ts  Parameter conversion, interval preview, answering, undo
    queue.ts      Study day, daily limits, queue building and ordering
  db/
    types.ts      Domain types, defaults, and the conventions they follow
    db.ts         Dexie schema, migration chain, sync add-on, persistence helpers
    cloud.ts      Whether this build syncs (VITE_DEXIE_CLOUD_URL), and where
  repo/           THE PERSISTENCE BOUNDARY — components import only from here
    decks.ts      Deck CRUD, cascade delete, per-deck counts
    notes.ts      Note CRUD; every write reconciles cards in the same transaction
    cards.ts      Card generation, FSRS shape conversion, reconcileCards
    media.ts      Blob storage, orphan audit, ref-counted object URL cache
    bulk.ts       Many-note tag/move/suspend/delete/restore, one transaction each
    stats.ts      Stats reads; loading training data; applying fitted weights
    meta.ts       Settings (device-local vs synced) and FSRS params
    index.ts      Barrel + domain type re-exports
  lib/
    id.ts         UUIDs, note content hashing, SHA-256 for media
    time.ts       Study-day arithmetic with a configurable rollover hour
    text.ts       Small string helpers: filenames, splicing, media markdown
  routes/         Layout, DeckList, DeckDetail, AddNotes, EditNote, CsvImport, Browse, Stats, Settings
  ui/             NoteEditor, CardPreview, SegmentView, MediaEmbed, BarChart, SchedulingPanel,
                  SyncPanel, SyncBadge, useSync, TagInput, Dialog, Stat, theme
```

## Keyboard shortcuts

Editing:

| Key | Action |
| --- | --- |
| `Alt+C` | Wrap the selection as a new deletion |
| `Alt+Shift+C` | Wrap the selection on the *current* card |
| `Ctrl/⌘+Enter` | Save |
| `Esc` | Cancel |

Anki binds cloze to `Ctrl+Shift+C`. That is unusable in a browser: it opens the
devtools element picker before the page ever sees the event, so it cannot be
intercepted. `Alt+C` is free everywhere.

Reviewing:

| Key | Action |
| --- | --- |
| `Space` | Reveal, then answer Good |
| `1` `2` `3` `4` | Again / Hard / Good / Easy |
| `u` | Undo the last answer |
| `e` | Edit the current note |
| `Esc` | Leave the session |

Browsing:

| Key | Action |
| --- | --- |
| `/` | Focus the search box |
| `Esc` | Clear the search (while in it) |
| `Shift`+click | Select every row between this checkbox and the last one clicked |

### Conventions worth knowing before touching anything

**Timestamps are epoch milliseconds, never `Date`.** IndexedDB indexes numbers
reliably; `Date` round-trips but comparing across the boundary is a source of
small surprises. Conversion happens only at the `ts-fsrs` call site, which
accepts a number as a `DateInput` anyway.

**Notes and cards are separate.** A note is what you author — one block of text
with `{{c1::…}}` markup. Each distinct ordinal generates one card with its own
scheduling state. This is Anki's model and it is what makes editing a note safe.

**Notes and cards are soft-deleted.** `deletedAt` marks them; the rows stay.
Review history is expensive to earn and impossible to recover, so a typo fix
that momentarily drops a deletion must not destroy it. Deck deletion is the one
hard delete, and the UI confirms it.

**Everything goes through `src/repo`.** No component imports Dexie. That is what
keeps a later swap of the persistence layer — File System Access API so decks
are real files on disk, or a sync backend — confined to one directory.

**`useLiveQuery` queriers must be read-only.** Dexie runs them in a read-only
context and throws on a readwrite transaction, correctly: a query that writes
would retrigger itself forever. The getters in `meta.ts` therefore read and fall
back to defaults in memory; row creation happens at boot and on write paths.

### Note types

A note is either **cloze** (text with `{{cN::…}}` deletions) or **basic** (a
front and a back, optionally asked both ways). `src/notetypes.ts` is the single
place that knows the difference; everything downstream asks it which cards a
note generates and how they render, and never branches on type itself.

**Basic notes ride on the existing machinery rather than sitting beside it.** A
basic note generates ordinal 1, and ordinal 2 as well when `reverse` is on.
Because `reconcileCards` already takes an ordinal list, the entire card
lifecycle — creation, soft delete, restore, scheduling, history, export — works
for basic notes without a line of change. Turning `reverse` off retires card 2
and keeps its review history, exactly as deleting a `{{c2::…}}` does, and
turning it back on restores the same card.

### CSV import/export

CSV is *interchange*, not backup. It carries `text, back, reverse, extra, tags`
per row — no ids, no scheduling state, no media — and it is deck-scoped and
single-type per file, because that is what an arbitrary spreadsheet actually
gives you. Anki's own CSV importer works the same way: pick one note type for
the whole file, map columns, import. A deck that mixes cloze and basic notes
still exports fine, but re-importing it means choosing one type, same as any
other CSV; a full multi-type copy with history is what JSON backup is for.

**Column mapping exists because headers are arbitrary.** "Acronym" and
"Definition" are never going to auto-map to front and back on their own —
`guessMapping` only recognizes a fixed dictionary of common header names
(front/back/answer/definition/tags/…), and leaves anything else unmapped for
the person to assign. Getting the guess wrong costs nothing; the preview table
shows the real effect on real rows before anything is written.

**Planning and importing share one classification pass.** `importer.ts`'s
`classify()` decides blank/duplicate/ok once; both `planCsvImport` (the
preview) and `importCsv` (the commit) call it, so they cannot disagree about
what will happen. Phase 4 hit exactly this bug once already — `buildQueue` and
`reinsert` computing the learn-ahead window two different ways — so here it's
one function instead of two copies of the same logic.

**Duplicate detection loads the deck's content hashes once, not per row.** A
query per row is invisible at 20 rows and unusable at 2,000.

**The type is an optional field defaulting to cloze**, and a cloze note stores
no type at all. So there is no schema migration, no backup format bump, and
every note and backup written before basic notes existed is still a cloze note.

For acronyms specifically, cloze is often still the better tool: one note
`{{c1::SPN}} = {{c2::Service Principal Name}}` gives you both directions as two
independently scheduled cards. Basic earns its place where the question is not a
sentence with a hole in it.

### Media

An image or audio clip attached to a note is just a `![alt](media:<uuid>)`
reference inside its text — cloze text, a basic front/back, or extra, all the
same syntax. `repo/media.ts` stores the actual bytes as a `Blob` in its own
table, keyed by a fresh id; the note text only ever holds the reference, which
is what keeps a note small enough to hash, diff and export as plain text
regardless of how many screenshots are pasted into it.

**Attaching is paste-or-pick, on any of the three text fields.** Each
field's "Attach" button opens a file picker (`accept="image/*,audio/*"`,
though the real gate is the code checking the mime type, not that hint); a
pasted screenshot is intercepted in the field's `onPaste` handler and attached
the same way, so a clipboard paste never dumps clipboard-internal junk into
the text. Both paths funnel through one `attachBlob` in `NoteEditor.tsx`,
which is also where the 15 MB size cap and the image/audio type check live —
one rejection path, not two.

**Bytes are deduplicated by content hash, not by reference.** `addMedia`
hashes the blob with SHA-256 and returns the existing row on a match, so
pasting the same screenshot into ten notes stores it once. This is the same
dedup strategy `notes.ts` uses for note content, applied to the other thing in
this app that is expensive to store twice.

**Rendering goes through one component for both kinds of media.** `MediaEmbed`
asks the repo for the blob's object URL *and* its mime type together — the
markup only ever says `media:<id>`, so nothing else about the reference tells
you whether it's a picture or a clip — and picks `<img>` or `<audio controls>`
once that resolves. Object URLs are reference-counted in `repo/media.ts` rather
than minted per render, so a review session doesn't leak a blob URL on every
card. `SegmentView` keys each media segment by position *and* id
(`` `${i}:${seg.id}` ``) rather than position alone, so editing a note that
swaps which media sits at a given spot remounts a fresh `MediaEmbed` instead of
reusing one whose in-flight load was for the old id.

**The editor's live preview is not the full card.** The "→ answer" line for a
basic card (and a cloze answer's revealed text) is a one-line plain-text
summary — `cardAnswerText`/`segmentsToText` — by design, so a long answer
doesn't blow up the preview panel; a media reference there shows as a
`[alt]` placeholder rather than a rendered image. The **front** and the
**extra** field, by contrast, render in full, media included, because neither
is meant to be condensed. Attached media always renders in full during an
actual review — this is a preview-panel shorthand, not a limitation of review.

**The maintenance story is audit, not silent cleanup.** `auditMedia()` scans
every live note's fields (`noteFields()` from `notetypes.ts` — the same
dispatch backup and hashing use, so a basic note's *back* field is included;
an earlier version of this scan hardcoded `[text, extra]` and would have
flagged a basic note's back-field media as an orphan) and reports **orphans**
(stored, nothing refers to it — safe to delete) separately from **dangling**
references (referenced, nothing is stored — those cards show a broken-media
marker; nothing to clean up from this side). Settings surfaces both and lets
you delete orphans on demand; nothing is ever deleted automatically.

### Browse

`#/browse` lists every live note in every deck, with a search box, sortable
columns and bulk actions (add/remove tag, move, suspend, unsuspend, delete).
The search language is a small subset of Anki's, so the muscle memory
carries over:

| Query | Matches |
| --- | --- |
| `word` · `"two words"` | text anywhere in the note — front, back or extra |
| `net*` | wildcard; stays within one word in text |
| `-anything` | negates any clause, filters included |
| `tag:ad` · `tag:none` | has the tag · has no tags |
| `deck:"Active Directory"` | in that deck (`*` works in the name) |
| `type:basic` · `type:cloze` | note type |
| `is:due` `new` `learning` `review` `suspended` `empty` | card state; `empty` = generates no cards |
| `added:7` · `edited:7` | within the last 7 study days |

Clauses are AND-ed; there's no OR or grouping. Case and accents are ignored
on both sides, so `resume` finds "résumé".

**Text search runs over rendered plain text, not the stored markup.** Cloze
deletions are shown (`{{c1::KDC}}` is searched as `KDC`), media collapses to
its alt text, and a search for `c1` finds nothing. Tags are *not* part of the
free text; `tag:` is how you search them, as in Anki.

**Indexing and filtering are separate passes.** `indexNotes` renders every
note to folded plain text once per database change (it's wrapped in
`useLiveQuery`); `filterEntries` compiles the query once and runs it over that
index on each keystroke. Re-parsing thousands of notes' cloze markup per
keypress is what would make the box stutter.

**The parser never throws.** A half-typed `tag:`, an unknown `tga:foo`, an
unclosed quote — each becomes a warning under the box and the rest of the query
still runs. Single-letter prefixes (`C:\Windows`) are searched as text without
a warning.

**`is:due` means what the review screen would show today:** a learning or
review card, not suspended, due before the end of the current study day. New
cards are never "due".

**The search lives in the URL** (`#/browse?q=…&sort=…&dir=…`). Opening a note
from Browse and cancelling or deleting returns to the same search; typing
replaces the history entry rather than adding one per keystroke, while clicking
a filter chip pushes one, so Back undoes it. The deck page's "Search this deck"
link is just a `deck:` query.

**Bulk actions touch only selected rows that still match.** Selection survives
changing the search (so you can tag, then move, the same set), but the count on
the action bar — "4 of 7 notes selected" — is exactly what an action will
change. Every action in `repo/bulk.ts` is one transaction and reports what it
actually changed ("Tagged 3 notes (2 already had it)").

**Moving a note moves its cards and review logs too.** Cards carry a
denormalized `deckId` for the due-queue index and logs carry one for daily
limits, so all three move together — the rule `moveDeckContents` already
followed for whole decks. Retired cards move as well, so restoring one later
lands it in the right deck.

**Delete is undoable.** It's the same soft delete as everywhere else; the
result banner's Undo runs `restoreNotes`, which re-reconciles each note and
brings back the same card rows with their scheduling history. Cards that were
already retired before the delete stay retired.

### Stats

`#/stats` shows, for all decks or one, over the last 30 days, 90 days or a
year (both in the URL):

- **Tiles:** answers and time today, cards due today and this week, true
  retention, and the study streak.
- **Reviews:** answers per day, stacked review / learning / new. A year is
  drawn as weekly columns — 365 daily ones would be slivers under a pixel.
- **Due in the next 30 days:** learning and review cards only; new cards
  arrive through the daily limit, not a due date.
- **Cards:** new, learning, young (interval under 21 days), mature, suspended.

**Every day is a study day,** bucketed with the rollover hour — the same rule
the queue and the optimizer use, so a 1am session counts where you'd expect
and the numbers agree across screens.

**Retention is *true retention*:** the pass rate (Hard/Good/Easy vs Again) on
cards that had already graduated. That's the number desired retention promises
something about; learning steps and first sightings would blur it. When it
drifts four or more points from the target, over at least 50 reviews, the
page suggests running the optimizer.

**The charts are hand-rolled SVG** (`ui/BarChart.tsx`), not a library — the app
ships as one offline file. They follow the dataviz rules the colors were
checked against: series colors (`--viz-*` in `index.css`) validated for
colorblind separation in both themes, in the stack order they're drawn in;
columns capped at 24px with a 2px gap between stacked segments; text never in
a series color; a legend only for more than one series; hover *and* arrow-key
tooltips; and a table view under each chart so no number is hover-only.

### Fitting FSRS to your reviews

Settings → Scheduling has **desired retention** (70–97%) and the
**optimizer**, which fits FSRS's 21 weights to your own review log. It's
two-step on purpose: *Optimize* changes nothing and shows how the current and
fitted weights score; *Apply* is a separate click.

**It's scored on cards it never saw.** One card in five (chosen by a hash of
its id, so the split is stable) is held out of training. The result compares
current vs fitted weights on those cards only — log loss and calibration error
— and only offers *Apply* when the fitted weights are better by a real margin.
An in-sample comparison would say "better" every time. It needs at least 400
reviews that came a day or more after the previous one.

**The model is ts-fsrs's, restated for speed.** ts-fsrs keeps its parameters
behind a `Proxy`, which is fine for scheduling one card and about 30× too slow
to replay a whole history thousands of times. `optimizer/model.ts` restates the
same formulas, rounding and clamps; `optimizer.test.ts` replays random
histories through both and requires identical states, so a ts-fsrs upgrade that
changes a formula fails a test before it can mis-train anything. Candidate
weights are clipped with ts-fsrs's own `clipParameters`, so what's scored is
exactly what the scheduler will run.

**How it fits:** binary cross-entropy (the fsrs-rs objective) minimized by Adam
over forward-difference gradients, in a normalized space (initial stabilities
on a log scale, everything else scaled 0–1 across its legal range). A small L2
pull toward the *library defaults* — fading as history grows — stops a thin
history producing extreme weights. Anchoring to the defaults rather than the
current weights means the objective is the same every run: optimizing again
right after applying finds nothing to add, instead of drifting further each
time. Past 40,000 scored reviews, training uses a stable subset of cards;
scoring still uses every held-out card.

**Which history counts:** a card's log must start at its first review (logged
state `New`); a card imported with state but no history is skipped rather than
guessed at. Days are study days. Same-day reviews update the memory state
(FSRS's short-term formula) but aren't scored.

**Applying recomputes, never reschedules.** Each studied card's stability and
difficulty were estimated under the old weights, so applying replays its
history under the new ones — the same replay the optimizer scored. Due dates
don't move; the next answer simply starts from a better estimate. *Reset to
defaults* does the same with the default weights.

**It runs on the main thread**, yielding between iterations, with a progress
bar and Cancel. A Web Worker would be nicer, but it's a second file, and the
standalone `cloze.html` must run from `file://`, where a module worker can't
load. A few thousand reviews fit in about 3 seconds; around 15,000 take
roughly 15.

**Verified against a known truth.** `optimizer/simulate.ts` generates a
learner whose memory follows *chosen* weights. Tests check the optimizer closes
most of the gap from the defaults to that truth on held-out cards, recommends
no change when started from the truth, and is stable when re-run.

## Sync

Sync is opt-in at build time. Set `VITE_DEXIE_CLOUD_URL` and the app signs in
to that [Dexie Cloud](https://dexie.org/cloud/) database and syncs everything
across your devices — decks, notes, cards, review history, media, synced
settings and fitted FSRS weights. Leave it unset and the Dexie Cloud add-on
isn't even in the bundle.

### Setting it up

1. **Create the database.** In the repo folder:

   ```bash
   npx dexie-cloud create
   ```

   It asks for your email, sends a code, and prints your database URL. It also
   writes `dexie-cloud.json` (the URL) and `dexie-cloud.key` (a CLI client id
   and **secret**). Both are git-ignored; keep them that way.

2. **Whitelist where the app will run.** Dexie Cloud refuses requests from any
   other origin:

   ```bash
   npx dexie-cloud whitelist http://localhost:5173           # npm run dev
   npx dexie-cloud whitelist http://localhost:4173           # npm run preview
   npx dexie-cloud whitelist https://<your-user>.github.io   # GitHub Pages
   ```

   The origin is scheme + host (+ port), never a path — Pages serving from
   `/<repo>/` still whitelists as `https://<your-user>.github.io`.

3. **Run it locally.** `cp .env.example .env.local`, paste the URL in, then
   `npm run dev`. You'll be asked for your email and a one-time code before the
   app opens — sign-in is required up front (`requireAuth`), so everything you
   create belongs to your account from the start.

4. **Deploy to GitHub Pages.** Push the repo to GitHub, then:
   - Settings → Pages → Source: **GitHub Actions**
   - Settings → Secrets and variables → Actions → **Variables** → New:
     `DEXIE_CLOUD_URL` = your database URL (a variable, not a secret — it ships
     in the JavaScript anyway)
   - Push to `main`. `.github/workflows/build.yml` tests, builds with the URL,
     and deploys. Until the variable exists, the deploy job is skipped.

5. **Bring over your existing decks.** The hosted app is a different origin
   from the `cloze.html` file you've been using, so it starts empty. In the old
   copy: Backup → Export (whole collection). In the hosted app, signed in:
   Backup → Import, mode **Add**. Everything comes across, review history
   included, and syncs from there.

6. **Check your account on each device** under Settings → Sync. Dexie Cloud's
   free plan covers 3 production users and 100 MB. If Settings → Sync shows an
   *evaluation* countdown on your account, make your user a production user in
   Dexie Cloud's management tools before it runs out.

### What syncs and what doesn't

| Syncs | Stays on the device |
| --- | --- |
| Decks, notes, cards, review logs, media | Theme |
| Study-day rollover, backup reminder, last backup | Storage-persistence grant |
| Desired retention and FSRS weights | Schema stamp (`meta` table) |

Device-only state is in `meta`, listed in `unsyncedTables`. Synced settings are
in the `profile` table as two rows, `#settings` and `#fsrs`. The `#` makes them
Dexie Cloud **private ids** — one per user, not one shared key — and splitting
them means changing a setting on your phone can't overwrite weights you just
fitted on your laptop. Reads fall back to `meta` until the first synced write,
so upgrading from a local-only build loses nothing.

### How the app stays safe under sync

**Every write touches only the fields it changes.** Sync means a device often
writes based on a copy of a row that another device has since changed. A
whole-row `put` would silently revert that other change, so none of the app's
edits use one:

- answering or undoing a card writes only its schedule, so a suspension made
  on another device survives
- saving a note writes its content fields, not the whole note
- bulk tag, move and suspend in Browse write only the tag, deck or flag field
- applying fitted weights writes only each card's stability and difficulty,
  never its due date

`src/repo/sync-safety.test.ts` pins each of these by writing from a stale
copy and checking the other change survived. The rule for new code: to change
a row, `update` the fields; `put` is for rows being created.

**Review logs can't conflict:** they're only ever added. Two devices reviewing
the same card offline both keep their logs. The card itself ends up with the
schedule from whichever answer synced last, and the optimizer, stats and
retention all read the logs, so nothing is lost from the history.

**Backups never carry sync bookkeeping.** Dexie Cloud stamps rows with
`owner` and `realmId`. Export strips them, and import strips them from older
files, so a backup restores cleanly into any account.

**Restore now reaches every device.** Backup → Import → Restore clears your
collection, and with sync on that clearing syncs too. The dialog says so.
Export first. Sync also faithfully copies mistakes, so a periodic export is
still the one copy no device can change.

**Media syncs through Dexie Cloud's blob storage.** Images and audio are moved
out of the sync stream and downloaded in the background after sync (the
default `eager` mode), so study works offline. The 100 MB free-plan limit is
mostly a media question.

### Not verified here

Everything above was tested against the local build, plus a sync build pointed
at a placeholder URL. That test confirmed the add-on loads, the sign-in prompt
appears, Settings → Sync reports state, and the only traffic goes to the
configured database. Real sign-in and real two-device sync need your
database, so they're the first thing to try once it exists.

## The cloze grammar

```
{{cN::answer}}
{{cN::answer::hint}}
```

N is 1-based. The same ordinal may appear several times in one note; every
instance blanks together on that ordinal's card, and other deletions show their
answers as ordinary context.

**Parsing is a tokenizer, not a regex.** The obvious
`/\{\{c(\d+)::(.*?)\}\}/` breaks on braces inside the answer, and any LaTeX is
enough to trigger it: in `{{c1::\frac{1}{2}}}` the first `}}` a regex finds is
the tail of `{2}}`, so it closes in the wrong place and silently produces a
mangled card. The scanner tracks brace depth and only closes on a `}}` sitting
at the depth the opening `{{` established.

**`::` inside an answer follows Anki's rule** — the first unescaped `::` starts
the hint, and everything after it is hint. So `{{c1::std::vector}}` parses as
answer `std`, hint `vector`. That keeps decks interchangeable, but it is a real
hazard for technical material, where the "hint" can give the answer away.

Escape it: `{{c1::[Net.WebClient]\:\:DownloadString}}`. The escapes are `\:`
`\{` `\}` and `\\`. `wrapAsCloze()` applies them automatically, so selecting
text containing `::` and pressing the cloze shortcut does the right thing
without the author having to know any of this. It escapes braces only when they
*don't* balance, so LaTeX stays readable in the source.

**Nesting is rejected, not guessed at**, as in Anki. A nested deletion produces
an error diagnostic and the whole span stays literal text, so the author sees
the problem in the preview instead of receiving a strange card.

**Parsing is total.** Any string, however broken, yields a defined AST and a
diagnostic list — a half-typed edit must still render a preview, so the parser
degrades to literal text rather than throwing.

Diagnostics are severity-tagged. `error` means the note would produce a *wrong*
card (unclosed, nested, unbalanced braces); `warning` means a poor one (`c0`,
an empty answer, no deletions at all). `summarize()` rolls this up for the
editor's status line and save guard.

### The reconciliation rules

`reconcileCards(noteId, deckId, ordinals)` is the function that protects review
history. Three rules:

1. A **new** ordinal creates a fresh card.
2. A **missing** ordinal soft-deletes its card.
3. A **returning** ordinal restores the soft-deleted card, state intact, rather
   than creating a second one.

Renumbering (`c2` → `c1`) lands as "c1 already exists, c2 removed" — the
surviving card keeps its history. That is deliberately conservative: guessing
that a renumber is a rename would silently reassign history to the wrong prompt.

It takes the ordinal set as an argument rather than parsing text itself, so the
cloze parser and this logic stay independently testable.

## The review loop

**The study day starts at the rollover hour**, 4am by default, not midnight. A
session at 1am counts toward the previous day. Otherwise a late night silently
spends tomorrow's new-card budget and breaks your streak while you are still
studying. Decks may override the global setting.

**Daily limits are counted from the review log, not from a counter.** A counter
has to be reset by something, and that something breaks across tabs, reloads and
clock changes. Counting logs in the current study-day window is always right,
and the compound `[deckId+reviewedAt]` index makes it a range read.

A review log's `state` is the state the card was in *before* the answer, so
`state === New` is exactly "a card introduced today". That also means **learning
steps do not eat the review budget** — once a card is in learning you have
already spent the budget on it, and refusing to finish its steps would strand it
overnight.

**Learn-ahead**: when the queue would otherwise be empty, learning cards due
within 20 minutes are handed over rather than making you wait. Only when
otherwise empty, so a not-yet-due step never jumps ahead of work that is due.
`buildQueue` and `reinsert` share the horizon, so a card behaves identically
whether it stayed in the session queue or arrived on a rebuild.

**Ordering** is learning, then review, then new. Reviews come before new cards so
a backlog is worked down before more material is added.

**The queue lives in component state**, not re-read after every answer.
Answering is O(1), and a learning card due again shortly is spliced back in
locally by `reinsert`. When the local queue runs dry it is rebuilt, which is what
picks up learning cards that have since come due.

**Undo restores the exact previous card row** and deletes its review log. Not a
recomputed card — `ts-fsrs` offers `rollback`, but putting back the row we
already had is exact by construction and survives a parameter change mid-session.
Deleting the log is deliberate: a review the user took back is not a data point
about their memory, and keeping it would poison both the stats and any future
parameter training.

**One bad card cannot end a session.** FSRS rejects a card whose stored memory
state is self-inconsistent (stability set, difficulty unset, say). Authoring and
reviewing cannot produce one, but an import can — so the review screen catches
the failure, sets that card aside for the session and carries on, rather than
white-screening. Import (phase 6) should validate memory state on the way in.

## Backup

IndexedDB is evictable and lives in exactly one browser profile. Until a deck
has been exported there is *one* copy of it, so backup is a first-class screen
in the nav rather than a corner of Settings, and the nav shows a dot when an
export is overdue.

**Two containers, one format.** Plain `.json` when there is no media —
diffable, greppable, and fine to commit to a repo, which is a real way people
keep decks. A `.zip` holding that same `backup.json` plus a `media/` folder as
soon as there is media, because base64 inside JSON inflates the bytes by about a
third and makes a screenshot-heavy deck unmailable. The `media` field has been
in the envelope since version 1, even though attaching images arrives in phase
7: adding it later would mean versioning the format twice.

**The format has its own version**, separate from Dexie's. Exported files
outlive the local database, so every import runs `upgradeBackup` before anything
touches storage. There is one version today and the chain does nothing — it
exists now because the alternative is discovering at version 2 that version 1
files cannot be identified, and that discovery happens on the day someone needs
to restore.

**Three import modes, differing in what happens to identity:**

| Mode | Behaviour |
| --- | --- |
| **add** (default) | Everything gets fresh ids. Nothing existing can be touched, so importing twice makes two copies rather than silently overwriting. Name collisions are renamed. |
| **merge** | Decks matched by name, notes deduplicated by content hash. New material lands; duplicates are skipped and counted. |
| **restore** | Wipe and write the backup verbatim, ids and all. The disaster-recovery path, and the only destructive one. |

**Import always previews before it writes.** `planImport` computes what would
happen — counts, colliding deck names, duplicate notes, damaged cards —
touching nothing. That preview is what turns "replace everything" from a button
you are afraid of into one you can read before pressing.

**Two details that are easy to get wrong.** Media is deduplicated by hash, so an
imported image may resolve to a row that already exists under a different id;
every `media:<id>` reference in the imported notes is rewritten to match, or the
images silently break. And scheduling state is validated on the way in: FSRS
rejects a card whose stability and difficulty disagree, and it throws at *review*
time, long after the import, when the connection is no longer obvious. Bad cards
are reset at the boundary and reported in the result.

Soft-deleted notes and cards are included in exports deliberately — they still
hold review history, and dropping them would make "restore" lossy in a way
nobody would notice until they needed it.

## Adding a schema version

Append a new `.version(n).stores({…})` block in `db.ts` with only the tables
whose *indexes* changed, plus an `.upgrade()` if existing rows need rewriting.
Never edit an existing version block — users' browsers have already run it.

`SCHEMA_VERSION` is separate from Dexie's version number: it stamps the *export
format*, which outlives the local database, and every import checks it.

## Status

**All nine phases are complete.** Author cards one at a time or in bulk from
a spreadsheet, attach images and audio, find and reorganize them across decks,
study them with FSRS scheduling fitted to your own memory, see how it's going,
and export everything to a file you control.

- **Phase 1** — project skeleton, schema and migrations, repository layer,
  routing, deck CRUD, storage-persistence UI.
- **Phase 2** — the cloze engine: parser, renderer, editing helpers, 95 tests.
- **Phase 3** — the editor: quick-add and edit screens, live card preview,
  diagnostics, tags, note list.
- **Phase 4** — the review loop: FSRS scheduling, queue with daily limits and
  learn-ahead, keyboard-first rating with real intervals, review logging, undo.
- **Phase 5** — backup: versioned JSON/zip export, import with preview and three
  modes, format upgrade chain, damaged-card repair. Plus a light/dark toggle in
  the header.
- **Basic note type** (out of phase order, on request): a front/back note with
  an optional reverse card, riding on the ordinal machinery above.
- **Phase 6** — CSV: column-mapping import with a live preview and plan, deck
  export, per-deck from `DeckDetail`. Deck-scoped and single-type per file; see
  "CSV import/export" above for why.
- **Phase 7** — media: paste-or-pick attachment on any text field, dedup by
  content hash, a `MediaEmbed` that renders images and audio through one
  component, and a Settings panel that audits and cleans up orphaned blobs on
  demand. See "Media" above.
- **Phase 8** — browse: a cross-deck note list with an Anki-style search
  language, URL-synced search and sort, and bulk tag/move/suspend/delete with
  undo. See "Browse" above. Also: the top bar now fits a phone-width screen.
- **Phase 9** — stats and the FSRS optimizer: review history, due forecast,
  true retention, streak and card counts; a desired-retention setting; and an
  optimizer that fits FSRS weights to your log, judges them on held-out cards,
  and recomputes memory states when applied. See "Stats" and "Fitting FSRS to
  your reviews" above.
- **Sync** (after the roadmap, on request): optional Dexie Cloud sync behind
  `VITE_DEXIE_CLOUD_URL`: required sign-in, device-local vs synced settings,
  field-level writes throughout so devices don't overwrite each other, backups
  that stay portable between accounts, and a Pages deploy workflow. See
  "Sync" above.

Saving is permissive by design: `createNote`/`updateNote` store the text and
return `diagnostics` for the caller to surface. The editor refuses to save on an
*error* (markup that would produce a wrong card) but allows *warnings*; bulk
import (CSV, and the JSON backup importer) allows both, because one malformed
row should not abort a thousand good ones. Soft-delete is what makes that
safe — a bad save retires cards, it never destroys their history. The edit
screen reports what reconciliation did ("Saved · added c2", "Saved · retired
c2") rather than leaving you to guess.

### Testing

`npm test` covers the pure layers — the cloze grammar, the CSV parser/mapper,
the browse search language, the stats math, the optimizer (including a
line-for-line parity check against ts-fsrs and recovery of known weights from
simulated reviews), the repository's reconciliation logic, and the media,
bulk-edit, stats and settings repos against fake-indexeddb, plus
`sync-safety.test.ts`, which writes from stale copies to prove no edit
reverts another device's change — the places where a silent
bug costs real review history, a silently-wrong bulk import or bulk edit, a
wrongly-deleted blob, or a scheduler trained on the wrong model. The React
components have no unit tests; they are verified by driving the built
app in Chromium, which is also what catches the class of bug a mocked test
would miss (the phase-1 `liveQuery` write, and the phase-7 paste/upload flow,
which needs a real `<input type=file>` and a real clipboard event to mean
anything).

That's the planned roadmap done, plus optional multi-device sync through
Dexie Cloud (see [Sync](#sync)). Natural next steps, none started: per-deck
FSRS presets (`DeckConfig.fsrs` already exists as an optional override but has
no UI), sharing a deck with another person (Dexie Cloud realms support this),
and a "reschedule to new weights" option for people who want due dates moved,
not just memory estimates.
