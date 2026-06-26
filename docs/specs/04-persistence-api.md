# 04 — Persistence + Auth

Status: **Schema + auth + upload→analyze implemented** in `apps/server`
(verified host + Docker).

## Decisions

### Per-user books (no dedup for now)

Each uploaded book belongs to the uploader (`books.userId`). We considered a shared
canonical library keyed by a **content hash** to dedupe processing across
re-uploads/translations, but rejected it for now: any re-export or metadata tweak
changes the hash, so it would reprocess constantly *and* still miss true duplicates.
The schema stays forward-compatible if we revisit dedup later (e.g. a `user_books`
join over canonical `books`).

### Auth: Better Auth, email + password, no verification

[Better Auth](https://better-auth.com) (chosen over the now-deprecated Lucia), backed
by our Drizzle/Postgres via its Drizzle adapter. v1 enables **email + password with
no email verification**, so self-hosting needs no SMTP. Social logins and verification
are later config additions, not rewrites.

### Schema lives in Drizzle; `drizzle-kit push` for dev

All tables — Better Auth's and ours — are defined in Drizzle and applied with
`drizzle-kit push` (dev). Switch to generate+migrate before production.

## Schema

Better Auth tables (`db/auth-schema.ts`, camelCase columns to match the adapter):
`user` · `session` · `account` · `verification`.

Domain tables (`db/schema.ts`):

| Table | Columns |
|---|---|
| `books` | id, **userId**→user, title, author, translator, language, identifier, sourceFilename, status(`uploaded\|processing\|ready\|failed`), error, chapterCount, tokenCount, **reviewedAt**, createdAt |
| `book_words` | id, **bookId**→books(cascade), word, lemma(null), count, level(null), isStopword · unique(bookId, word), index(bookId, count) |
| `known_words` | id, **userId**→user, language, lemma, createdAt · unique(userId, language, lemma) |

`lemma`/`level` are nullable now and populated by later phases (lemmatization,
enrichment). "Mark book reviewed" = `books.reviewedAt` + `known_words` for v1; a
per-word learning-state table (`learning/known/ignored`) can come with the review UI.

## Auth wiring (`apps/server`)

- `auth/auth.ts` — `betterAuth({ database: drizzleAdapter(db,{provider:"pg",schema}), emailAndPassword:{enabled:true, requireEmailVerification:false} })`.
- `routes/auth.ts` — catch-all `GET|POST /api/auth/*` bridging Fastify ⇄ the Fetch
  API `auth.handler` expects; Set-Cookie headers forwarded individually.
- `auth/session.ts` — `getSession(request)` and a `requireAuth` preHandler (401 +
  attaches `request.user`). Example protected route: `GET /api/me`.
- CORS uses `credentials: true` + the web origin so session cookies flow.
- env: `BETTER_AUTH_SECRET` (≥32 chars, required in prod), `BETTER_AUTH_URL`, `WEB_ORIGIN`.

## Gotcha (recorded so we don't trip again)

`@better-auth/cli` (1.4.21) lags `better-auth` (1.6.20) and drags in an incompatible
`better-call`, which breaks **both** the CLI's `generate` *and* better-auth at runtime
(`SyntaxError: ... 'better-call' does not provide an export named 'kAPIErrorHeaderSymbol'`).
Fix: don't depend on the CLI — the auth schema is hand-written from the
[documented core schema](https://better-auth.com/docs/concepts/database) and verified
against a live sign-up/session/sign-in flow. Revisit the CLI for regeneration once its
version catches up.

## Upload → analyze (implemented)

The raw EPUB is stored in `book_files` (bytea) so any worker instance can read it
(no shared disk; swap for object storage at scale). Flow:

1. `POST /api/books` (multipart EPUB, ≤50 MB) → insert `books`(uploaded) + `book_files`
   in one tx → enqueue pg-boss `process-book` → `202`.
2. Worker `process-book` → `readEpub` + `analyzeBook` (@lexiprep/core) → replace
   `book_words` (stopwords flagged, not dropped) → set book `ready` + metadata
   (title/author/language/identifier) + chapter/token counts. Failures set `failed`
   + `error`. Idempotent (clears prior words), runs in-process for now.
3. `GET /api/books` (user's shelf) · `GET /api/books/:id` (status) ·
   `GET /api/books/:id/words` — frequency list, most-frequent first, hiding stopwords
   and the user's `known_words` by default (`?includeStopwords` / `?includeKnown` /
   `?limit` / `?offset`). All routes require a session; non-owned/invalid ids → 404.

## Verified

- Server unit tests: `/health`, `/api/demo` (core), `/api/me` → 401, book routes → 401.
- Live auth (host + Docker): sign-up → session cookie → `/api/me` → sign-in.
- Live upload (host + Docker): the real Odyssey EPUB → worker → `ready`
  (43 chapters, 150 176 tokens, 10 774 unique words) → `/words` top = `odysseus`(1083),
  `home`(476)…, matching the core CLI. Cascade delete of the user clears all rows.

## Next

- **Review loop + known/learning words** — see [05-review-and-known-words](./05-review-and-known-words.md).
  Supersedes the standalone `known_words`: it unifies into `user_words(status)`
  (`learning|known|ignored`), adds batched review + "mark reviewed", and extends
  `GET …/words` to return level/example/status and exclude all triaged words.
- **Enrichment** — see [03-enrichment](./03-enrichment.md): eager CEFR `level` for all
  words, lazy on-click `definitions` (pluggable provider, cached), and `book_words.example`
  captured in core.
- Phase 2 lemmatization (populate `book_words.lemma`; match `user_words` by lemma) —
  see [02-lemmatization](./02-lemmatization.md).
- generate+migrate workflow for production (currently `drizzle-kit push`).
