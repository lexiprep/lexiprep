# lexiprep — project guide

Pre-reading vocabulary extractor for ebooks: EPUB → frequency-sorted, level-filtered,
known-words-aware word list to study *before* reading (LingQ-like, but front-loaded).
English first, Spanish later. Open source, self-hostable. Full design in `docs/specs/`.

## How to work in this repo

- **Valeriu is the lead developer and directs the work.** Do exactly the task asked —
  no more. Do **not** write unrequested implementation code or widen scope; present a
  plan/options and get an explicit go-ahead first. When in doubt, ask rather than build.
  (Saving specs ≠ building the feature.)
- Confirm before anything outward-facing or hard to reverse.

## Architecture & key decisions

- **Two separate repos.** This repo is the **app**. The extraction engine lives in its
  own reusable, open-source repo — **`lexiprep-core`** (package `@lexiprep/core`, MIT) —
  and is consumed as a dependency. Do not vendor pipeline logic here; contribute it to
  `lexiprep-core`.
- **App layout:** `apps/server` (Fastify 5, Drizzle + Postgres, pg-boss) and `apps/web`
  (React 19 + Vite), both depending on `@lexiprep/core`. Skeleton scaffolded.
- **Postgres + Drizzle** (not SQLite) and **multi-user from day one.** "Self-hostable"
  here means **multi-tenant** — it may serve a family, a group of friends, or paid
  subscriptions. Avoid choices that cap horizontal scale; flag any that do.
- **pg-boss** for background jobs (parsing/enrichment), running on Postgres — no Redis.
- **EPUB only** for v1 (PDF/MOBI deferred). "Filter by pages" maps to chapter/spine ranges.

## Conventions

- TypeScript, ESM, `NodeNext` (server) / `Bundler` (web), strict. pnpm workspace (`apps/*`).
- Default branch `develop`.
- **Never commit ebooks** — `*.epub` is gitignored; test books are local-only and often
  copyrighted.

## Commands

```
make up      # Docker: Postgres + server + web (migrations run on start)
make down    # stop & remove
make build   # build images
make test    # run all tests; optional: make test filter=<name>
```

`@lexiprep/core` is consumed as a published **npm dependency** (`^0.1.0`), so no sibling
checkout is needed in dev or prod; installs use `--frozen-lockfile` (the lockfile must be
committed). To hack on the engine locally, `pnpm link` a `lexiprep-core` checkout. Host dev
without Docker also works: `pnpm install && pnpm -r dev`. Releasing core: bump its version,
push a `vX.Y.Z` tag → the release workflow publishes to npm via OIDC; then bump the app's
`@lexiprep/core` range.

## Status

- Phase 1 (core extraction) done — separate `lexiprep-core` repo (`@lexiprep/core` + CLI,
  tested).
- App **skeleton** scaffolded & verified: Fastify (`/health`, `/api/demo` using core),
  Drizzle + Postgres, pg-boss, Vite/React web. `make up` brings the whole stack up
  healthy in Docker (db + server + web), DB connected, core working in-container.
- **Auth + data model + upload→analyze** done (`docs/specs/04`): Better Auth
  (email+password, no verify) on Fastify; Drizzle schema (`user/session/account/
  verification` + `books`/`book_files`/`book_words`/`known_words`, **per-user**).
  `POST /api/books` (multipart) → pg-boss `process-book` → `@lexiprep/core` →
  `GET /api/books[/:id[/words]]` (stopwords + triaged words hidden). Verified host + Docker.
  Note: do NOT add `@better-auth/cli` (its version lags and breaks `better-call`).
- **Review loop + known/learning words** done (`docs/specs/05`): `known_words`
  unified into **`user_words(status: learning|known|ignored)`**, cross-book. Batched
  triage — `POST /api/books/:id/review` (`{words, learning}` → flagged=learning,
  rest=known; or `{finish:true}`), `GET …/words` excludes all triaged + returns
  level/example/status, `GET …/words/:word` (modal detail; lazy definition slot),
  `GET|POST|DELETE /api/words` (vocabulary mgmt). Verified end-to-end in Docker.
- **Web UI (initial)** done: React 19 + Vite, React Router, TanStack Query +
  **TanStack Table**, Better Auth React client. Pages: login/signup, books
  (upload + status polling), book review table. Table does **server-side
  multi-column sort** (shift-click headers → `?sort=level:desc,count:desc`) and a
  **CEFR `minLevel` filter** (`?minLevel=A2`), batched review (20/50/100, "Mark
  reviewed", "Finish book"), click-a-word **modal** (mark known/learning/ignored;
  lazy-definition slot). Verified end-to-end in a real browser (Playwright).
  Server `GET …/words` gained `sort` + `minLevel` params for this.
- **CEFR levels + lemmatization** done (`docs/specs/03`, `02`): `@lexiprep/core` computes
  a base-form `lemma` per word (`wink-lemmatizer`, opt-in `analyzeBook(b,{lemmatize:true})`).
  Bundled CEFR wordlist (`apps/server/data/cefr/en.csv`, **8,679 lemmas A1–C2** from
  CEFR-J + Octanove; CC BY-SA — see `NOTICE.md`) → `word_levels` table via `pnpm db:seed`
  (wired into Docker startup; also backfills existing books). `process-book` sets
  `book_words.level` by `coalesce(lemma, word)`, so inflected forms level via their base
  (`men`→man→A1, `suitors`→suitor→C1). Activates the level sort/filter. Regenerate the
  wordlist: `pnpm --filter @lexiprep/server exec tsx scripts/build-cefr-csv.ts`.
- **Conjugation grouping + review UX** done: `GET …/words` groups by `coalesce(lemma,word)`
  — one row per base form, counts summed (`say` 396), sorted/filtered/paginated over groups;
  modal lists every surface form; review/known key on the lemma. Response also returns
  `stats {total, remaining, filtered}` (shown in the header; replaced the unclear "tokens").
  Web table: checkbox moved right + accent-colored/larger, **Mark reviewed** moved to a
  bottom bar, mobile-responsive. Verified in browser (desktop + mobile).
- **Definitions** done (`docs/specs/03`): bundled offline dictionary in a `definitions`
  (language, lemma, senses jsonb) table — **74,441 lemmas** from **Open English WordNet 2025**
  (CC BY 4.0). Loaded/refreshed by **`make dict-update`** (`apps/server/scripts/build-definitions.ts`):
  downloads the zip, unzips in-Node (jszip), joins entries→synsets, **upserts** (never deletes →
  zero-downtime; re-runnable). Not run on startup (10 MB) — run once after `make up`. The modal
  shows up to 5 concise senses (POS + gloss + example) via `getWordDetail`.
- **Definition fallback + per-book notes** done: words missing from WordNet fall back to the
  **Free Dictionary API** (`dictionaryapi.dev`, Wiktionary) on modal-open, cached into
  `definitions` (source `freedict`, negatives too → fetched at most once). Per-book user notes
  in `word_notes(user, book, lemma)` — `PUT/DELETE /api/books/:id/words/:word/note`, shown/edited
  in the modal as an addition (not override). Modal UX: status buttons **toggle** (click the
  active one to undo), forms inline, action buttons pinned in a scroll-fixed footer.
- **Review stages + mass-ignore** done: `reviewBatch` takes `rest: known|ignored` →
  "Mark reviewed" (rest known) and **"Ignore rest"** (rest ignored, for junk) sit together at
  the bottom. Stats gained `unleveled`; the book opens with a **first-stage gate** — until the
  untriaged unleveled words (level "—": names/rare words, queried via the `none` sentinel) are
  cleared, the leveled review is blocked. **"Finish book"** moved to the top with a danger
  **ConfirmDialog** (high-stakes). NOTE: the FE (BookPage, LevelRange, LearningPage, nav) is
  being actively co-developed by the user — coordinate before large rewrites.
- **Triage view filter** done: `getBookWords`/stats take `status` (`""`/untriaged default →
  "to review"; `all`; `known`/`learning`/`ignored`). Default list shows only untriaged words;
  a toolbar **View** select (To review / All words / Known / Learning / Ignored) shows any
  subset at any time — and is always visible (so "All words" escapes the junk gate). Replaced
  the old `includeTriaged` checkbox; `includeTriaged=true` kept as a server alias for `all`.
- Roadmap in `docs/specs/00-overview.md`: (2) lemmatization, (3) enrichment
  (CEFR levels eager / context examples in core / definitions lazy+pluggable —
  Cambridge isn't open-cacheable, default is Free Dictionary API/Wiktionary),
  (5) review loop *(done)*, (6) web UI *(initial done)*, (7) Spanish.
