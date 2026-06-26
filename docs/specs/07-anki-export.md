# 07 — Anki export (spaced-repetition deck)

Status: **Implemented.** Export the user's **Learning** vocabulary as an Anki deck —
the word in context on the front, its definition (hidden) on the back.

## Scope (decided)

- **Source = the `learning` list only** (cross-book `user_words.status = 'learning'`). Export
  lives on the Vocabulary → **Learning** tab; the button is hidden on Known/Ignored.
- **Card** — front: the word over its first-occurrence **context sentence**; back: the
  cached **definition** (POS + gloss per sense). Context always exists ([03-enrichment]),
  so a card is never contextless even when there's no definition (it shows "no definition").
- **Optional filters** in an export modal: one or more **books** (a learning word is included
  if it occurs in a selected book) and a **CEFR range**. No selection = all books / all levels.
- Deck size is unbounded in practice (≈2k words is fine).

## Format — TSV (decided)

Plain **tab-separated** file Anki imports natively, with header directives so import is one
click: `#separator:tab`, `#html:true`, `#columns:Front\tBack`. Fields are HTML (`<div>` for
the word/context, `<i>POS</i> gloss` per sense); tabs/newlines inside a field are neutralised
(→ space / `<br>`). Download is `lexiprep-anki-<date>.tsv`.

**Why TSV, not `.apkg`:** `.apkg` (via genanki-js) needs a bundled SQLite/WASM toolchain and
can't be validated without an Anki client; TSV is dependency-free, robust, and imports cleanly.
`.apkg` (turn-key import, embedded note type/styling) is a possible upgrade — see open questions.

## Implementation

- **Server.** `buildAnkiDeck(userId, { language, bookIds, minLevel, maxLevel })` in
  `books/service.ts` — learning words joined to a per-lemma book aggregate (level + context),
  filtered by book/level, with definitions bulk-read from the `definitions` cache (no per-word
  network fetch — a 2k export stays fast; uncached words get an empty back). `GET
  /api/words/export` renders the TSV with download headers (auth via the session cookie, so a
  same-origin `GET` just works).
- **Web.** `ExportModal` (books checkboxes + `LevelRange`) on the Learning tab triggers the
  download via a temporary `<a>`.

## Open questions

- **`.apkg` export** with a styled note type and embedded media (audio later) — better import
  UX than TSV; deferred for the dependency cost.
- **Definitions coverage.** The back is empty for words with no cached sense. Options: warm the
  cache before export (the on-click Free Dictionary fallback already caches per word), or run a
  bulk fetch as part of export. Current: cache-only, fast.
- **Pronunciation / audio** on cards — store URLs vs. bundle; licensing-dependent.

[03-enrichment]: ./03-enrichment.md
