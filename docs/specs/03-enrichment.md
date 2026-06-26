# 03 — Enrichment (levels, definitions, context examples)

Status: **Designed** (this spec). Three independent enrichments with different
timing and sources. Context-example capture is a `@lexiprep/core` change; levels and
definitions are app concerns.

## What gets enriched, and when

| Enrichment | Coverage | Timing | Source |
|---|---|---|---|
| **CEFR level** | **every** word | **eager** — at book processing | bundled static wordlist (offline) |
| **Context example** | every word (1 per surface form) | **eager** — at extraction, in core | the book itself |
| **Definition** | every word with a sense | **bundled offline** — `make dict-update`, looked up on modal open | Open English WordNet (CC BY 4.0) |

Driven by the decisions in [05-review-and-known-words]: levels must cover the whole
list so level-filtering and sorting work up front; definitions are needed only for the
handful of words a reader actually inspects, so they're fetched on click and cached.

## CEFR levels — eager, static, offline

Every `book_words` row gets a `level` (A1–C2, or null if unlisted) during processing,
by looking the word/lemma up in a **bundled open CEFR wordlist** loaded once into a
`word_levels(language, lemma, level, source)` table. No per-request network calls;
level filtering is a plain column filter. A pluggable `LevelProvider` keeps the source
swappable (bundled dataset vs. an external API), mirroring `DefinitionProvider`.

**Two tiers** populate `word_levels` (the `source` column tells them apart; the seed
loads them in priority order and the first writer wins per `(language, lemma)`):
1. **Vetted** — CEFR-J + Octanove (`en.csv`, 8.7k lemmas). Trusted, hand-curated.
2. **Estimated** — frequency-derived A1–C1 (`en-freq.csv`, ~51k). Fills only words the
   vetted tier misses. Added 2026-06-26 because the vetted list alone left ~half a real
   book unleveled, including common words it never listed (`lord`, `knight`). See below.

### Source decision (researched 2026-06, implemented)

**Default: bundle two files from [openlanguageprofiles/olp-en-cefrj](https://github.com/openlanguageprofiles/olp-en-cefrj)**,
combined into `apps/server/data/cefr/en.csv` (`lemma,level,source`) by
`apps/server/scripts/build-cefr-csv.ts`:
- **CEFR-J Vocabulary Profile 1.5** → A1–B2 (A1 1164 / A2 1411 / B1 2446 / B2 2778
  headwords). CEFR-J terms: free for research *and commercial* use, with citation
  (Tono Lab, TUFS).
- **Octanove Vocabulary Profile C1/C2 1.0** → **C1 1111 / C2 1025** headwords.
  CC BY-SA 4.0 (Octanove Labs).

Lowercased, slash-variants split, **one level per lemma = MIN CEFR** (level first
introduced) → **8,679 lemmas (C1 925, C2 890 after dedupe)**. Loaded into `word_levels`
via `pnpm db:seed` (idempotent); `book_words.level` is set in the `process-book`
transaction by matching `coalesce(lemma, word)`. Attribution in `data/cefr/NOTICE.md`
(the combined file is CC BY-SA 4.0). Free, offline, scales.

**Estimated fallback tier: Maximax67/Words-CEFR-Dataset (MIT).** Originally rejected as
the *primary* source — its `level` is an interpolated **numeric 1–6** scale (not vetted
CEFR letters) with unreliable advanced levels — and that rejection stands *for the primary
role*: vetted C1/C2 still comes from Octanove. But the curated list is small, so the same
dataset is now adopted as the **estimated second tier** for words the vetted list lacks.
Its levels are computed from **overall English frequency** (Google Books 1-grams) + CEFR-J
— exactly the "how common is this word in English generally" signal we want for a fallback.
Built by `apps/server/scripts/build-cefr-freq-csv.ts` into `en-freq.csv` (`source='freq'`):
join `word_pos.csv`→`words.csv`, one level per surface word = MIN across its POS rows,
single-token filter, map numeric 1–5 → A1–C1.

**We drop the dataset's C2 (level 6).** In it, C2 is a catch-all for rare/unknown words —
~74% of all entries, nonsense words (`foo`) included — not a vetted advanced grade. Keeping
it would flood the C2 filter with ~121k junk words and empty the first-stage "unleveled"
triage gate. So we keep **A1–C1 (~51k lemmas; 43k of them new vs. vetted)** and leave the
rest unleveled, as before — genuinely rare/archaic/proper words stay `—` for manual triage,
and real advanced vocabulary is still covered by the vetted Octanove C2 tier on top. Spot-
checks after this change: `lord`→A1, `knight`→B1, `suitor`→A2 (were all unleveled before).

**Optional paid provider: [Cathoven CEFR API](https://www.cathoven.com/cathoven-ai-tools-apis/)**
($0.08/call, text-level → cents/book) slots in behind a future `LevelProvider`.

**Rejected: Cambridge / EVP** — the API returns CEFR (`lvl` from the EVP), but the EVP
prohibits commercial use and the free API tier forbids storing/caching (3k calls/mo).
**Rejected: EFLLex** — A1–C1 only (no C2), distributions not single levels.

### Matching: lemma-keyed dictionary + lemmatization

The dataset is lemma-keyed, so inflected forms (`men`, `killed`, `gods`) only level via
their base form. Lemmatization ([02-lemmatization], now implemented in `@lexiprep/core`
via `wink-lemmatizer`) populates `book_words.lemma`; the level match on
`coalesce(lemma, word)` then levels inflected words through the lemma (`men`→man→A1,
`suitors`→suitor→C1). With the vetted tier alone, ~6,400/10,774 Odyssey words leveled —
the ~40% gap was *not* just proper nouns and rare words (common words like `lord`/`knight`
were simply absent), which is why the estimated freq tier (above) was added to close it;
what remains `—` is genuinely rare/archaic/proper, the intended manual-triage set.
**Caveat:** lemmatization is
POS-agnostic, so ambiguous forms (`leaves`→leave vs. leaf) resolve to one reading; a
POS-aware upgrade (wink-nlp) is possible later without API changes.

## Context examples — captured in core, at extraction

**Status: implemented.** `analyzeBook(…, { captureExamples: true })` attaches the
first-occurrence sentence per surface form (`splitSentences` + short-sentence padding);
`processBook` stores it in `book_words.example`. Every word gets one (a context match is
always available — the word came from the text), so the modal always shows context even
when no definition exists. Verified: Odyssey 10,647/10,647 words have an example.

For each distinct surface word, store **one** example sentence so the reader sees it in
context (hover) and each conjugation shows its own usage (modal — [02-lemmatization]).

Capture rule (implemented in `@lexiprep/core`, since it owns the text and
tokenization):

- Segment chapter text into sentences.
- Take the word's **first occurrence**, use that sentence as the example.
- **If that sentence has fewer than 4 words**, extend it with the **previous and next**
  sentence (concatenated) so the snippet has real context.
- Strip nothing semantic; keep original casing/punctuation for display.

Storage: `book_words.example` (text). Because examples are per **surface form** and
each surface form is its own `book_words` row, a lemma's conjugations each carry their
own example automatically — exactly what the modal needs ("1 phrase per conjugation").

Core change: `analyzeBook` (or a sibling) returns, per word, `{ word, count, example }`
instead of just `{ word, count }`. This is a new capability in the separate
`lexiprep-core` repo (adds sentence segmentation) — speced here, built there.

## Definitions — bundled offline dictionary (implemented)

Implemented as a **bundled offline dictionary** rather than a live provider:
`definitions(language, lemma, senses jsonb, source, updatedAt, unique(language, lemma))`,
where `senses` is a short array `{ pos, gloss, example? }[]` (capped at 5 — the most
useful meanings). `getWordDetail` looks it up by `book_words.lemma` and returns it with
the modal; no per-request network call.

**Update pipeline — `make dict-update`** (`apps/server/scripts/build-definitions.ts`):
downloads **Open English WordNet 2025** (CC BY 4.0), unzips in-Node (jszip), joins
lexical entries → synset glosses, and **upserts** into `definitions`. Loaded **74,441
single-word lemmas**. Re-runnable any time to refresh. **Zero-downtime by design:** the
new data is downloaded and fully parsed in memory *before* any write, and writes are
UPSERT only (never delete) — a failed download leaves the live dictionary intact.
Not run on startup (10 MB download); the operator runs it once after `make up`.

A pluggable live provider (Free Dictionary API) can still be added later as a fallback
for the rare words WordNet misses; not needed for v1.

### Provider choice (researched 2026-06)

Cambridge isn't open in the self-host sense, **but** it does have a real free tier:
**free under 3,000 calls/month**, then £50/month for ~15k. The catch (Cambridge FAQ):
you **may not store/cache** the data without a separate license, and the intended
pattern is live server-side fetch handed straight to the user. That rules Cambridge
out as the cache-and-export backbone (no global cache; can't bake its text into Anki
exports), but it's fine as a **live, on-click** source for a small instance under the
free cap.

Resolution — ship a pluggable provider:

- **Recommended default: bundle [Open English WordNet 2024](https://github.com/globalwordnet/english-wordnet)
  (CC BY 4.0).** Download once into `definitions` — same offline pattern as the CEFR
  wordlist. **161,705 words / 120,630 synsets**, JSON release (`oewn-2024.json.zip`),
  concise glosses with **multiple senses per word** (the "useful variations of
  meanings"), plus examples/synonyms. Permissive (attribution only), commercial-OK,
  zero runtime dependency, scales, exportable to Anki. Trim to top N senses for the
  "short" goal. Keyed by (lemma, pos) → matches our `book_words.lemma`.
- **Optional fast fallback: Free Dictionary API** (`api.dictionaryapi.dev`, Wiktionary
  CC BY-SA) — no key, multiple defs + examples; quickest to ship and a live fallback for
  the rare words WordNet misses. External dependency + rate limits.
- **Alternative: [Wordset](https://github.com/wordset/wordset-dictionary)** — friendlier
  learner-style wording, JSON, but less comprehensive than WordNet.
- **Optional: Cambridge** (`cacheable: false`) — live only under its free 3k/mo tier;
  not cached, not exported (EVP terms).

## Open questions

- CEFR dataset resolved and implemented (CEFR-J + Octanove, 8,679 lemmas — see above).
  Remaining: conjugation **display grouping** (merge `echo/echoes/echoing` into one row
  with summed count) is not done yet — words are leveled by lemma but still shown as
  separate surface rows; that's the next slice of [02-lemmatization].
- Definition quality: Wiktionary glosses are uneven; whether to pre-rank senses or
  trim to the top sense for hover.
- Pronunciation/audio: store URLs only, or proxy/cache audio (licensing-dependent).
- Should `learning` words be pre-fetched in the background (warm the cache + Anki) or
  stay strictly on-click? Current decision: strictly on-click; revisit if the study
  list feels slow.

[02-lemmatization]: ./02-lemmatization.md
[05-review-and-known-words]: ./05-review-and-known-words.md
