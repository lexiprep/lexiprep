# lexiprep

Pre-reading vocabulary preparation for ebooks. Upload a book, get its vocabulary
**sorted by frequency**, with the words you already know hidden, basic stopwords
filtered out, definitions and in-context examples attached — so you can learn the
most useful words *before* you start reading.

Think LingQ, but front-loaded: instead of looking words up while you read, you
prep the high-value vocabulary first, then read more fluently.

> Status: early development. Working name — easily renamed before first release.

## Why

For intermediate/advanced learners, most of a book's *unique* words are either
already known or too basic to bother with. The valuable signal is the handful of
genuinely new words you'll meet often. lexiprep surfaces exactly those:

- **Frequency-first.** Most-used unknown words rise to the top — learn what pays off.
- **Known-words aware.** Mark words you know once; never see them again across books.
- **Level filter.** Hide words below your CEFR level; focus on your growth edge.
- **Stopword filter.** `the`, `a`, `on`, `this` never waste your time.
- **Context + definitions.** Each word with its definition and example sentences from the book.
- **Export.** Send to Anki, or review in-app.

English first; the pipeline is built to extend to Spanish and other languages.

## Architecture

Two repos:

| Repo | What it is |
|---|---|
| [`lexiprep-core`](https://github.com/lexiprep/lexiprep-core) ([`@lexiprep/core`](https://www.npmjs.com/package/@lexiprep/core), MIT) | Reusable, framework-agnostic pipeline: EPUB → clean text → tokens → frequency list. Pure TypeScript, fully tested, no server/DB deps. Published on npm. **Built.** |
| `lexiprep` *(this repo, AGPL)* | The app: `apps/server` (Fastify, Postgres + Drizzle, `pg-boss` jobs, multi-user auth) and `apps/web` (React + Vite). Consumes [`@lexiprep/core`](https://www.npmjs.com/package/@lexiprep/core). **Working.** |

The extraction engine is its own open-source library so it can power this app, a CLI,
other projects, or run client-side. **It was built first.**

See [`docs/specs/`](./docs/specs/) for the full specification.

## Run

```bash
cp .env.example .env
make up        # Postgres + server + web in Docker (migrations run on start)
# web → http://localhost:5173   ·   server → http://localhost:3000/health
make down      # stop
make test      # tests (optional: make test filter=<name>)
```

Host dev without Docker also works (`pnpm install && pnpm -r dev`); start Postgres
yourself or point `DATABASE_URL` at one. After `make up`, run `make dict-update` once to
load the offline dictionary.

> The app consumes [`@lexiprep/core`](https://www.npmjs.com/package/@lexiprep/core) from npm —
> no sibling checkout needed. To hack on the engine locally, `pnpm link` a
> [`lexiprep-core`](https://github.com/lexiprep/lexiprep-core) checkout.

## Deploy (self-host)

A separate production stack (`docker-compose.prod.yml`) keeps node_modules in volumes, so
deploys don't reinstall. Core comes from npm, so prod needs **only this repo**.

**First run** (one time) — clone, set strong secrets in `.env` (`POSTGRES_PASSWORD`,
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_ORIGIN`; optional `BACKUP_R2_*` for backups),
then:

```bash
make install   # build images + populate the deps volumes
make migrate   # create the schema (drizzle-kit push)
make seed      # load CEFR word levels
make prod-up   # start the stack (db, server, web, caddy, backup)
make prod-dict # load the offline dictionary (~10 MB, one time)
```

A **Caddy** reverse proxy is the public entry. By default it serves plain HTTP on `:80`, so
the app is reachable at **`http://SERVER_IP`** immediately — set `BETTER_AUTH_URL`/`WEB_ORIGIN`
to that. When you have a domain, set `SITE_ADDRESS=your.domain` in `.env` (and switch those two
to `https://your.domain`); Caddy auto-provisions HTTPS on `:443`.

**Every update after that:** `make deploy` (git pull → rebuild → swap with minimal downtime →
migrate). `make prod-up` / `prod-down` / `prod-logs` manage the stack; `make backup` runs a
DB backup now. See [`docs/specs/08-deployment.md`](./docs/specs/08-deployment.md).

## Status

Working end to end: upload an EPUB → background extraction (frequency, lemmatization, CEFR
levels, context examples, proper-noun detection) → frequency-sorted review with per-user
known/learning/ignored vocabulary, definitions, and **Anki export**. Multi-user, Postgres,
self-hostable. Per-feature design records in [`docs/specs/`](./docs/specs/).

## License

AGPL-3.0-or-later — open source; self-host for yourself, your family, or a group.
