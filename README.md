# AnkiPWA

AnkiPWA is an offline flashcard app for your browser. It schedules reviews with FSRS, the same algorithm current Anki uses, and works the same way Anki does. You install it on Android or iPhone from a GitHub Pages site. It needs no account or server, and your cards never leave your device.

> **Status: all five milestones are built (v0.2.2).** Study with FSRS or SM-2; import and export Anki decks and collections with progress and media; import spreadsheets, Quizlet and JSON; read cards aloud and answer by voice; search and bulk-edit cards; see statistics; and do custom study. See the [roadmap](#roadmap).
>
> AnkiPWA is an independent project and is not affiliated with Anki or AnkiWeb.

## Features

- **Decks**
  - Nested decks using `::` (e.g. `Telugu::Grammar`).
  - Due counts for new · learning · review cards.
  - Collapse decks; create, rename and delete them.
- **Note types**: Anki's stock types: Basic, Basic (and reversed card), Basic (type in the answer), and Cloze (`{{c1::answer::hint}}`). A cloze note with several numbers makes several cards.
- **Templates**:
  - Supported syntax: `{{Field}}`, `{{FrontSide}}`, `{{#F}}…{{/F}}`, `{{^F}}…{{/F}}`, `{{cloze:F}}`, `{{type:F}}`, `{{hint:F}}`, `{{text:F}}`, plus the `Tags`, `Deck`, `Subdeck`, `Card` and `Type` special fields.
  - Media: `[sound:x.mp3]` and `<img src="x.jpg">`.
  - Cards render in a sandboxed frame where no script can run.
- **Scheduler**
  - **FSRS-6** is the default: 21 default parameters, desired retention adjustable from 80 to 97%. It is checked against the reference `ts-fsrs` implementation in the tests.
  - **SM-2** works the way Anki's legacy scheduler does: ease, hard/easy multipliers, interval modifier, lapse settings.
  - Learning and relearning steps (`1m 10m 1d`), including steps of a day or more.
  - Graduating and easy intervals, maximum interval, and Anki's interval fuzz.
  - Per-deck daily limits with an optional limit across all decks.
  - "Next day starts at" hour, burying of new, review and interday-learning siblings, and leech threshold with tag or suspend.
- **Review**
  - Tap the card or press Space to flip.
  - The Again/Hard/Good/Easy buttons show the next interval.
  - Multi-level undo, flags 1–7, bury, suspend, reset to new, set due date, and card info (history, stability, difficulty, retrievability).
  - The **Search chip** copies the question, with cloze answers hidden, and opens a Google search. Tapping it doesn't flip the card.
- **Study more**: raise today's new or review limit for a deck.
- **Editor**
  - Bold, italic and underline; a cloze button (Ctrl+Shift+C).
  - Paste, drop or upload images; they are stored offline.
  - Pin fields to keep their content between adds; tags.
- **Import** (Files → Import, or share a file to the app on Android)
  - Anki `.apkg` and `.colpkg` from Anki desktop, AnkiDroid and AnkiMobile, in both the current format (`collection.anki21b`, zstd) and the older ones (`collection.anki21` / `.anki2`), with scheduling, FSRS memory state, review history, deck presets and media.
  - **Merge** matches notes by GUID, so importing the same deck again updates it instead of duplicating it. Choose whether existing notes are updated (if newer / always / never), whether progress is imported, and whether cards you already have take the file's progress when it is newer. **Replace** swaps in a whole collection, like Anki does with `.colpkg`.
  - Anki "Notes in Plain Text" `.txt` with its `#separator`, `#html`, `#columns`, `#notetype`, `#deck`, `#tags` and `#… column` headers.
  - CSV/TSV (any separator, quoted fields) with a column-to-field mapping, header-row detection, duplicate handling (update / skip / add) and extra tags.
  - Quizlet exports (pick the separators you exported with), pasted text, and JSON (`[{"Front": "…", "Back": "…", "tags": "…"}]`).
  - Android Share Target and desktop file handlers open shared files straight in the import screen.
- **Export** (Files → Export, or a deck's ⋮ menu)
  - `.apkg` for one deck or all, with or without progress and media; `.colpkg` with everything.
  - Packages use Anki's "support older versions" layout, which every current Anki client imports. FSRS memory state travels in each card, so Anki continues where you left off.
  - Anki `.txt` (with GUID, note type, deck and tags columns) and CSV for spreadsheets.
- **Speech**
  - Card audio plays like Anki: `[sound:]` files, `{{tts en_US:Field}}` (with `speed=`) and AnkiDroid's `<tts voice="en_US">` tags are spoken once, in order, with a ▶ button to replay. The answer doesn't replay the question's audio.
  - Read cards aloud (for cards without their own audio) with a voice picker and speaking rate. The answer is read without repeating the question, and cloze gaps are read as "blank".
  - Each writing system gets a matching voice: on a card with English and Telugu, each part is read in its own language. This also covers Hindi, Tamil, Japanese, Chinese, Korean, Arabic, Russian and more.
  - Hands-free: the answer is shown automatically a set number of seconds after the question has been read.
  - Answer by voice: say "show", then "again", "hard", "good" or "easy" (or one to four); "undo" and "repeat" also work.
  - The screen stays awake while reading aloud or listening.
- **Browse**
  - Anki-style search: words, `"phrases"`, `-not`, `or`, `( )`, `*` and `_` wildcards, `deck:`, `tag:` (with child tags, `tag:none`), `note:`, `card:`, `Field:value`, `is:new/learn/review/due/suspended/buried/flagged`, `flag:N`, `prop:ivl/due/reps/lapses/ease/pos/s/d/r` comparisons, `added:`, `edited:`, `rated:N[:ease]`, `introduced:`, `re:`, `nid:`, `cid:`.
  - Cards or notes view, eight sort orders, and quick filters.
  - Bulk actions: suspend, flag, change deck, add or remove tags, bury, reset, set due date, reposition, delete, and "study these in a filtered deck".
- **Statistics** for the collection or a deck: today, streak, a year's review heatmap, reviews per day, a 30-day forecast, true retention (young / mature, like Anki), average FSRS recall, and card counts. Each chart has a table view.
- **Custom study and cram**: raise today's limits, review forgotten cards, review ahead, preview new cards (without changing their scheduling), study by state or tag (with or without rescheduling), or study the cards you are most likely to forget. These make Anki-style filtered decks that you can rebuild or empty; cards always return to their own decks.
- **Backup**
  - One lossless JSON file containing everything, including review history, media and settings.
  - Download it, or share it to Drive or WhatsApp on phones.
  - A weekly reminder and the date of the last backup.
- **PWA**
  - Installable with an in-app Install button and an iPhone "Add to Home Screen" hint.
  - Works fully offline after the first visit.
  - Asks the browser for persistent storage.
  - Versioned database migrations, so updates never wipe data.
- **Comfort**
  - Light, dark or automatic theme, and adjustable text size.
  - One-handed layout at 360px, 44px tap targets, keyboard focus rings, and labelled buttons.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space / Enter | Show answer (on the answer side: Good) |
| 1 2 3 4 | Again · Hard · Good · Easy |
| U | Undo (multi-level) |
| E | Edit note |
| R | Replay audio / read aloud again |
| S | Search the question on Google |
| I | Card info |
| - | Bury card |
| @ | Suspend card |
| Ctrl+1…7 / Ctrl+0 | Set / clear flag |
| Ctrl+Enter | Add / save in the editor |
| Ctrl+Shift+C | Cloze (add Alt to reuse the number) |

## Deploy on GitHub Pages

1. Push this folder to a GitHub repository, with the files at the repository root (`index.html` next to `sw.js`).
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main`, folder `/ (root)`, and click **Save**.
4. After a minute the app is live at `https://<your-user>.github.io/<repo>/`. Open it on your phone and install it.

All URLs are relative, so the app also works from `/docs` or any sub-path. Nothing needs building. To publish an update, bump `VERSION` in `sw.js` (and `APP_VERSION` in `js/main.js`, and `version` in `package.json`). Installed apps then show "A new version is ready → Reload".

## Run locally and test

```bash
python3 -m http.server 8000      # then open http://localhost:8000/
npm install                      # dev-only: ts-fsrs (reference), fake-indexeddb
npm test                         # node --test tests/*.test.mjs
```

The Anki tests use real files made by the official Anki library. To rebuild them, and to check that real Anki imports what this app exports:

```bash
python -m venv .venv && .venv/bin/pip install anki         # Windows: .venv\Scripts\pip
.venv/bin/python tests/anki/make_fixtures.py               # rewrites tests/fixtures/*
ANKI_OUT=/tmp/out npm test                                 # also writes the exported files
.venv/bin/python tests/anki/check_export.py /tmp/out       # imports them into Anki and checks them
```

The tests cover:

- **FSRS**: compared with `ts-fsrs` over 200 random review histories.
- **Scheduler**: learning steps, graduation, SM-2 ease and interval maths, overdue credit, interday steps, fuzz ranges, leeches.
- **Day numbering**: how the rollover hour decides the day.
- **Rendering**: templates and cloze, including nested and unclosed clozes, hints, type-in answers, and the sanitizer.
- **Anki note checksum**: the result for `hello` is checked against a known value.
- **Storage**: adding, studying, limits, sibling burying and undo on an in-memory IndexedDB.
- **Backup**: a full round-trip.
- **Scale**: a 50,000-card collection, where due counts and the next card take well under a second.
- **Service worker**: a check that it precaches every module.
- **Anki import**: `.apkg` and `.colpkg` in the current and legacy formats, made by Anki 26.09: notes, cards, review history, FSRS memory state, presets, suspended and flagged cards, media, due dates moved onto this collection's calendar, merging twice without duplicates, and replace.
- **Anki export**: `.apkg` (all / one deck, with and without progress), `.colpkg`, `.txt` and CSV, read back and compared card by card. `tests/anki/check_export.py` imports the same files into real Anki.
- **Text import**: Anki `.txt` headers, re-import matched by GUID.
- **Search**: the query parser, every search term, and searches after studying.
- **Filtered decks**: custom study with rescheduling (cards go home when they graduate, learning cards stay, emptying returns everything), preview without rescheduling, deleting a filtered deck keeps its cards.
- **Statistics**: today, streak, card counts, forecast, and per-deck scope.

## Data safety

- Everything is stored in your browser's IndexedDB on this device. The app asks for *persistent* storage, and **Settings → Storage** shows whether the browser granted it.
- **Back up weekly** using **Backup → Download backup**, or **Share** to save it to Google Drive. A banner reminds you. Restoring a backup replaces everything on the device.
- Database upgrades are versioned migrations that keep existing data.

## Known limitations

- **iPhone storage:** Safari may delete a website's data after a period without use. Installed (Home Screen) apps are exempt, so install the app and keep backups.
- **Voice answers:** speech recognition needs internet and microphone permission on Chrome/Android. It is missing or unreliable on iOS, especially in installed apps, so the voice button is hidden there and you answer by tapping. Read aloud works everywhere the browser has voices.
- **Filtered decks** are not exported or imported (their cards travel in their home decks), and only the common filtered-deck options are offered.
- **Anki packages** are exported in the "older versions" layout. Every current Anki client imports it; it is a little larger than Anki's newest format.
- **No AnkiWeb sync.** AnkiWeb has no public API. Moving files (`.apkg` / `.colpkg`) will be the sync method.
- **FSRS parameter optimisation** is not built in. You can paste parameters optimised in Anki under Deck options → FSRS parameters. An optimiser will only be added if it reproduces Anki's results.
- **Templates:** add-on template features and JavaScript in card templates are not supported, because scripts are blocked for safety.

## Roadmap

1. ✅ **MVP:** decks, notes, FSRS/SM-2 review, backup JSON, PWA.
2. ✅ **Import:** `.apkg` / `.colpkg` (current and legacy formats) with scheduling, review history and media; merge by GUID or replace; Anki `.txt`, CSV/TSV with column mapping, Quizlet, JSON; Share Target on Android.
3. ✅ **Export:** `.apkg` (with or without progress and media), `.colpkg`, Anki `.txt`, CSV, and the round-trip checklist below.
4. ✅ **Speech:** read aloud with a voice picker and hands-free auto-reveal; voice grading with the screen kept awake.
5. ✅ **Browser and statistics:** Anki-style search with bulk actions; heatmap, forecast and retention; custom study and cram.

## Round-trip checklist (AnkiPWA ⇄ Anki)

Checked automatically against Anki 26.09 by `tests/anki/check_export.py`; worth repeating by hand on each Anki client you use.

1. **Anki → phone:** in Anki desktop choose File → Export → *Anki Deck Package*, tick *Include scheduling information* and *Include media*. AnkiDroid: ⋮ → Export; AnkiMobile: deck ⚙ → Export. Share the file to the phone and import it here (Files → Import). Decks, presets, due counts and card info should match Anki.
2. **Study on the phone** for a day.
3. **Phone → Anki:** Files → Export → `.apkg` with *Include progress* and *Include media*. In Anki, File → Import (AnkiDroid: ⋮ → Import; AnkiMobile: open the file). Notes are matched by GUID: nothing is duplicated, and cards you studied on the phone show the new intervals and review history. With FSRS on, Card Info shows the same stability and difficulty.
4. **Anki → phone again:** export from Anki with scheduling and import here with *Update progress of cards you already have* on. Cards reviewed more recently in Anki take Anki's progress; cards reviewed more recently here keep theirs.
5. **Whole collection:** a `.colpkg` replaces the collection on the other side. Use it only when one side is empty or out of date.
6. **Without progress:** an `.apkg` exported without progress is a clean deck to share; every card arrives as new.

## Demo checklist

1. Open the site and confirm the empty state appears. Tap **Add a card**.
2. Add a **Basic (and reversed card)** note and confirm the toast says "Added 2 cards". Add a **Cloze** note with `{{c1::…}}` and `{{c2::…}}`.
3. Under **Decks**, the Default deck shows **4 · 0 · 0**. Tap it, then tap **Study now**.
4. Tap the card to flip it. The buttons show intervals such as `1m · 6m · 10m · 6d`. Press **Good**.
5. Press **U** (or ↶) to undo. The same card returns and the counts restore.
6. Open **⋮ → Card info**. Then **⋮ → Flag → Red**: the card border turns red.
7. On a cloze card, tap **Search**. Google opens with the question and the answer is not included.
8. Open **Deck options**. Switch between FSRS and SM-2, move the retention slider, and save.
9. Under **Backup**, tap **Download backup**, then **Restore from file…** with that file. Everything returns.
10. On Android, tap **Install**. On iPhone, use Share → Add to Home Screen. Turn on airplane mode and reopen: the app still works.
11. **Files → Import** an `.apkg` from Anki: the decks appear with their due counts. Import it again: nothing is duplicated.
12. **Files → Export** an `.apkg` with progress and import it in Anki: intervals and review history arrive.
13. **Browse**, search `is:due tag:verbs`, select a few cards and suspend them.
14. On a deck, **Custom study → Preview new cards**: Again / Done buttons appear and scheduling doesn't change.
15. Turn on **🔊** in the review screen: the question is read aloud. On Android Chrome turn on **🎤** and say "show", then "good".
16. Open **Stats**: today's reviews, the heatmap and the forecast match what you studied.
