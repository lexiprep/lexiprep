# lexiprep specs

Design records for lexiprep. Each file captures **decisions and their reasoning**,
not a transcript. Update in place; rely on git for history.

| Spec | Status | Summary |
|---|---|---|
| [00-overview.md](./00-overview.md) | Living | Product vision, architecture, data model, roadmap |
| [01-word-extraction.md](./01-word-extraction.md) | Implemented (core) | EPUB → frequency-sorted word list (the first deliverable) |
| [02-lemmatization.md](./02-lemmatization.md) | Implemented | Conjugation grouping (wink-lemmatizer); list groups by base form |
| [03-enrichment.md](./03-enrichment.md) | Levels + definitions done | CEFR levels (CEFR-J+Octanove) + offline dictionary (OEWN, `make dict-update`); context examples pending |
| [04-persistence-api.md](./04-persistence-api.md) | Schema + auth + upload done | Drizzle schema (per-user) + Better Auth on Fastify |
| [05-review-and-known-words.md](./05-review-and-known-words.md) | Designed | Batched review loop; `user_words(status)`; known-words endpoints |
| [06-proper-nouns.md](./06-proper-nouns.md) | Core + auto-ignore done | Capitalization-based name detection (confirmed→ignored, likely→PN bucket) + `'s` stripping; FE bucket pending |
| [07-anki-export.md](./07-anki-export.md) | Implemented | Export the Learning list as an Anki TSV deck (word+context front, definition back) |
| [08-deployment.md](./08-deployment.md) | Implemented | Production self-host: `docker-compose.prod.yml` + `make deploy`/`install`/`migrate` |

Planned next specs: `09-spanish.md`.
