# lexiprep — Overview

## Goal

A self-hostable web app that turns an ebook into a **pre-reading vocabulary list**:
the words a reader will meet, sorted by frequency, with the words they already know
hidden, basic function words filtered out, and definitions plus in-context examples
attached. The reader preps high-value vocabulary *before* opening the book, then
reads more fluently.

Conceptually adjacent to LingQ, but front-loaded: prep first, then read — rather than
looking words up mid-read.

## Why this is useful (the core thesis)

For intermediate/advanced learners, most of a book's *unique* words are already
known or too basic to matter. The signal worth studying is the small set of
genuinely new words that recur. Therefore:

- **Frequency is the primary sort.** Frequent unknown words pay off most — they
  surface first. This is the central idea, not a feature toggle.
- **Known words are hidden.** A per-user "known words" set persists across books; a
  word marked known is never shown again.
- **Basic function words are filtered.** "the", "a", "on", "this" never appear.
- **Level filtering** lets a learner hide words below their CEFR level.

## Non-goals (initially)

- Not a reader/e-reader. We prep vocabulary; reading happens in the user's app.
- Not an SRS engine. We export to Anki and offer light in-app review; we don't
  reimplement spaced repetition scheduling.
- No PDF/MOBI ingestion in v1 (EPUB only — see [01](./01-word-extraction.md)).
- No grammar/sentence-difficulty analysis.

## Audience and scale

Primary user: the author and other intermediate/advanced learners. "Self-hostable"
explicitly means **multi-tenant** — host for a family, a group of friends, or a paid
service. The architecture is chosen so that path has no rewrite: stateless API,
Postgres, background workers, multi-user from day one.

## Architecture

Two separate repos:

| Repo (package) | Role | Status |
|---|---|---|
| `lexiprep-core` (`@lexiprep/core`, MIT) | Reusable, framework-agnostic pipeline: EPUB → text → tokens → frequencies. Pure TS, fully tested, zero server/DB deps. Usable by this app, a CLI, tests, the browser, or other projects. | Built |
| `lexiprep` → `apps/server` (AGPL) | Fastify REST API, Postgres + Drizzle, `pg-boss` jobs, auth. | Planned |
| `lexiprep` → `apps/web` (AGPL) | React + Vite review UI. | Planned |

Decisions and rationale:

- **Core as a standalone, reusable open-source library (its own repo).** The extraction
  logic is the valuable, testable asset; a separate MIT-licensed repo lets it be reused
  independently (and published to npm) while the app evolves separately. During local dev
  the app links the core package so changes don't require a publish cycle.
- **Postgres + Drizzle** (not SQLite). The scaling goal (family → friends →
  possible subscriptions) needs multiple API instances and managed hosting, which
  a single-file SQLite caps. Drizzle gives type-safe SQL with low runtime weight.
  Self-hosting stays one command via docker-compose.
- **`pg-boss` for background jobs** (not Redis/BullMQ). Parsing a book and
  enriching hundreds of words must not block requests in a multi-user app. pg-boss
  runs a durable, multi-worker queue *on the Postgres we already run* — no extra
  infrastructure. Revisit Redis/BullMQ only if throughput demands it.
- **Multi-user from day one.** The known-words set is inherently per-person; auth
  and per-user data isolation are in the schema from the start.
- **License: AGPL-3.0-or-later.** Open source, copyleft so hosted derivatives stay
  open. (Confirm with owner before first release.)

## Pipeline (end to end)

```
EPUB upload
  → readEpub()         unzip, follow OPF spine, strip XHTML → clean text per chapter
  → tokenize()         locale-aware word tokens (EN now, ES later)
  → analyzeBook()      frequency count, chapter-range filter, stopword/length filter
  → [phase 2] lemmatize   group conjugations/inflections under a base form
  → [phase 3] enrich      definitions + CEFR level + example sentences
  → [phase 4] persist     subtract user's known words; store per book/user
  → review or export      in-app review (mark known/new) or Anki export
```

Phases 1–3 are language/data processing (the core package grows here). Phases 4–5
are the app (server + web). See per-phase specs.

## Data model

Postgres, per-user, language-scoped. Implemented tables in
[04-persistence-api.md](./04-persistence-api.md); review/enrichment additions in
[05](./05-review-and-known-words.md) / [03](./03-enrichment.md).

- Auth: `user` / `session` / `account` / `verification` (Better Auth).
- `books` — owner, title/author/translator, language, identifier, source_filename,
  status (`uploaded|processing|ready|failed`), chapter/token counts, `reviewedAt`.
- `book_files` — raw EPUB bytes (bytea) so any worker can reprocess.
- `book_words` — per **surface form**: word, lemma, count, **level** (CEFR, eager),
  **example** (context sentence, from core), is_stopword, **proper-noun class**
  (`none|likely|confirmed`, book-scoped). Grouped by lemma at read time. [06]
- `user_words` — per user+language+lemma with **status** (`learning|known|ignored`);
  cross-book; the queue is "words with no row". Replaces the old `known_words`. [05]
- `word_levels` — bundled CEFR wordlist (language, lemma, level); populates
  `book_words.level`. [03]
- `definitions` — global lazy cache (language, lemma, provider, jsonb); only for
  cacheable providers. [03]

## Roadmap

1. **Word extraction** — EPUB → frequency list. *Done (core).* → [01](./01-word-extraction.md)
2. **Lemmatization** — group conjugations/inflections (wink-lemmatizer), aggregate
   counts under a base form, per-form examples. → [02](./02-lemmatization.md)
3. **Enrichment** — CEFR levels (eager, bundled offline dataset), context examples
   (captured in core), definitions (lazy on-click, pluggable provider — default Free
   Dictionary API/Wiktionary CC BY-SA; Cambridge optional live under its free 3k/mo
   tier). → [03](./03-enrichment.md)
4. **Persistence + API** — Postgres/Drizzle schema, Fastify endpoints, pg-boss
   processing jobs, auth, upload→analyze. *Done.* → [04](./04-persistence-api.md)
5. **Review loop + known words** — batched triage, `user_words(status)`, mark
   reviewed, known-words endpoints. → [05](./05-review-and-known-words.md)
6. **Web UI** — upload, frequency-sorted batched review hiding triaged words,
   level/stopword filters, hover gloss + click-to-modal, mark known/learning/ignored,
   Anki export (CSV + `.apkg` via genanki-js).
7. **Spanish** — tokenizer locale, ES lemmatizer, ES frequency/level data, ES
   stopwords. The pipeline is built to extend, not be rewritten.
8. **Proper-noun detection + possessive normalization** — capitalization-based name
   classification (confirmed → ignored, likely → "PN" filter bucket) and `'s` stripping,
   to clear names out of review and stop the freq tier mis-leveling them. → [06](./06-proper-nouns.md)

## Naming

Working name `lexiprep` (lexis + prep). Easily renamed before first release.
