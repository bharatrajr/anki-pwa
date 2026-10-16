# AnkiPWA

AnkiPWA is an offline flashcard app for your browser. It schedules reviews with FSRS, the same algorithm current Anki uses, and works the same way Anki does. You install it on Android or iPhone from a GitHub Pages site. It needs no account or server, and your cards never leave your device.

> **Status: milestone 1 of 5 (MVP).** You can study, add and edit cards, set deck options, back up and restore, and install the app. Importing from and exporting to Anki come in milestones 2 and 3. See the [roadmap](#roadmap).
>
> AnkiPWA is an independent project and is not affiliated with Anki or AnkiWeb.

## Features (milestone 1)

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
| R | Replay audio |
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

All URLs are relative, so the app also works from `/docs` or any sub-path. Nothing needs building. To publish an update, bump `VERSION` in `sw.js` (and `APP_VERSION` in `js/main.js`). Installed apps then show "A new version is ready → Reload".

## Run locally and test

```bash
python3 -m http.server 8000      # then open http://localhost:8000/
npm install                      # dev-only: ts-fsrs (reference), fake-indexeddb
npm test                         # node --test tests/*.test.mjs
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

## Data safety

- Everything is stored in your browser's IndexedDB on this device. The app asks for *persistent* storage, and **Settings → Storage** shows whether the browser granted it.
- **Back up weekly** using **Backup → Download backup**, or **Share** to save it to Google Drive. A banner reminds you. Restoring a backup replaces everything on the device.
- Database upgrades are versioned migrations that keep existing data.

## Known limitations

- **iPhone storage:** Safari may delete a website's data after a period without use. Installed (Home Screen) apps are exempt, so install the app and keep backups.
- **Speech (milestone 4):** speech recognition needs internet and microphone permission on Chrome/Android. It is missing or unreliable on iOS, especially in installed apps, so voice grading will fall back to tapping there.
- **No AnkiWeb sync.** AnkiWeb has no public API. Moving files (`.apkg` / `.colpkg`) will be the sync method.
- **FSRS parameter optimisation** is not built in. You can paste parameters optimised in Anki under Deck options → FSRS parameters. An optimiser will only be added if it reproduces Anki's results.
- **Templates:** add-on template features and JavaScript in card templates are not supported, because scripts are blocked for safety.

## Roadmap

1. ✅ **MVP:** decks, notes, FSRS/SM-2 review, backup JSON, PWA.
2. **Import:**
   - `.apkg` / `.colpkg` in both the legacy and current (zstd) Anki formats, with scheduling, review history and media.
   - Merge by GUID or replace.
   - Anki `.txt` with header lines, CSV/TSV with column mapping, Quizlet text, JSON.
   - Share Target on Android.
3. **Export:** `.apkg` (with or without progress and media), `.colpkg`, Anki `.txt`, CSV, plus the round-trip checklist for Anki desktop, AnkiDroid and AnkiMobile.
4. **Speech:**
   - Read aloud with a voice picker and hands-free auto-reveal.
   - Voice grading (again / hard / good / easy), with the screen kept awake.
5. **Browser and statistics:**
   - Anki-style search (`deck:` `tag:` `is:due` `flag:1` `prop:ivl>30` …) with bulk actions.
   - Statistics: heatmap, forecast, retention.
   - Custom study and cram.

## Milestone 1 demo checklist

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
