# 05 — Review loop + known/learning words

Status: **Designed** (this spec). Backend implementation next; web UI in [05-web-ui] later.

## Goal

Turn a book's frequency list into a **multi-session triage loop**. The reader works
through the unknown words a batch at a time, marking the few they want to study; the
rest of each batch is assumed known. Each return visit shows the next batch. The
known/learning state is the user's, persists across books, and drives what's hidden,
what's exported to Anki, and what gets a definition fetched.

## The review loop (core mechanic)

1. Open a book → see a **batch** of the highest-frequency words not yet triaged,
   each with its **count**, **CEFR level**, and a one-line **context example**.
2. Batch size is the reader's choice: **20 / 50 / 100** (client-driven page size).
3. The reader flags the words that are **new to them** (the ones worth studying).
4. Click **Reviewed** →
   - flagged words become **`learning`** (go to the study list / Anki),
   - every other word in the batch becomes **`known`** (hidden everywhere).
5. Next visit, the queue has advanced — the next batch is the next-most-frequent
   still-untriaged words. Repeat across sessions until the book is done.

"Mark whole book reviewed" remains a one-click shortcut: assume **all** remaining
untriaged words are known (and set `books.reviewedAt`).

Rationale: the value is in the small set of recurring unknown words. Forcing a
per-batch binary (flag the new ones; the rest you know) is fast, and the queue
self-advances because triaged words leave it. The reader never re-sees a word they've
already classified, in this book or any other.

## State model — unify `known_words` → `user_words`

One per-user, per-language vocabulary table with a status flag (degree of "known"),
replacing the standalone `known_words`. A word a user has classified has exactly one
row; an untriaged word has **no row** (that's how the queue is defined).

| Table | Columns |
|---|---|
| `user_words` | id, **userId**→user(cascade), language, lemma, **status**, createdAt, updatedAt · unique(userId, language, lemma) |

- `status`: **`learning`** (flagged to study) · **`known`** (mastered → hidden) ·
  **`ignored`** (never want to see — proper nouns, names → hidden). Ordered as a
  degree of familiarity; can widen to graded levels (LingQ-style 1–4) later without a
  migration (status is text).
- **lemma** is the match key, matched against `book_words.lemma ?? book_words.word`
  (surface word until lemmatization lands — [02-lemmatization]). Cross-book by design:
  classify "ephemeral" once and it's resolved in every book.
- `known_words` is dropped; existing known rows map to `status = 'known'`.

The **review queue** for a book = `book_words` where `is_stopword = false` AND the
word has **no `user_words` row** for (user, book.language), ordered by `count` desc.
All three statuses leave the queue (known/ignored are hidden; learning has moved to
the study list).

## API surface (all under `/api`, session-required, owner-scoped)

### User vocabulary (`user_words`) — the "known-words endpoints"

- `GET /api/words?language=en&status=learning|known|ignored` — list the user's marked
  words (omit `status` for all). Backs the study list and known-words management.
- `POST /api/words` — `{ language?, items: [{ lemma, status }] }` (or a single
  `{ lemma, status }`). Upsert; `language` defaults to the user's primary/`en`.
- `DELETE /api/words/:lemma?language=en` — remove the row (back to untriaged).

### Book review

- `GET /api/books/:id/words` — the batch. Existing endpoint, extended to return
  `level`, `example`, and `status` per row, and to exclude **every** triaged word by
  default (not just `known`). Query: `limit` (=page size 20/50/100), `offset`,
  `includeStopwords`, `includeTriaged` (escape hatch to see classified words too).
- `POST /api/books/:id/review` — the **Reviewed** button.
  `{ language?, words: string[], learning: string[] }`: `words` = the full batch the
  client showed; `learning` = the subset flagged. Server computes `known = words −
  learning` and bulk-upserts both into `user_words` in one transaction. Returns
  `{ learning: n, known: n }`.
  - `{ finish: true }` variant → mark all remaining untriaged words in the book
    `known` and set `books.reviewedAt`.
- `GET /api/books/:id/words/:word` — **word detail** for the modal: count, level,
  lemma, the surface forms (conjugations) grouped under the lemma each with its single
  example, and the **definition** (fetched lazily on this call — see
  [03-enrichment]). This is the only path that triggers a definition lookup.

## Hover vs. modal (interaction contract)

- **Hover** shows only the high-value glance: the first-sense **gloss**, **CEFR
  level**, and **count**. No network call beyond what the list already loaded.
- **Click → modal** shows the full record: all senses/POS, pronunciation, every
  **conjugation** (surface form) with its own one example, the primary context
  example, level, and the actions (**mark learning / known / ignored**). The
  definition is fetched here, lazily, and cached when the provider permits.

The list endpoint must therefore carry enough for hover (gloss + level + count);
the detail endpoint fills the modal and does the lazy definition fetch.

## Open questions

- Should `ignored` be surfaced in the UI as a distinct action, or folded into a
  "hide" that's reversible from a settings list? (Leaning: a quiet "ignore" action,
  reversible from the known-words manager.)
- Per-book vs. global study list view: learning words are global, but the modal's
  example is per book. The study view likely groups by lemma and shows the example
  from the book where it was flagged.
- Graded familiarity (LingQ 1–4) vs. the flat `learning/known/ignored` — deferred
  until the flat model is in use and we know whether grading earns its complexity.

[02-lemmatization]: ./02-lemmatization.md
[03-enrichment]: ./03-enrichment.md
[05-web-ui]: ./00-overview.md
