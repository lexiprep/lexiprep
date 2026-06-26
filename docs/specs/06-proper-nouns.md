# 06 — Proper-noun detection & possessive normalization

Status: **Core detection + auto-ignore + `'s` done**; FE "PN" bucket / Names rescue view
pending. Detection + `'s` stripping are `@lexiprep/core` changes; classification storage,
auto-ignore, and the filter bucket are app concerns.

**Implemented:** `@lexiprep/core` — `'s` strip in `normalizeWord`; `tokenizeWithContext`
(casing + sentence position); `analyzeBook(…, { detectProperNouns: true })` classifies each
surface form (`confirmed` ≥2 mid-sentence caps / `likely` 1). `apps/server` —
`book_words.proper_noun` column; `processBook` enables detection and **auto-ignores
confirmed names** (writes `user_words(status='ignored')`, `onConflictDoNothing`, skipping
groups with a vetted level). Verified on the Odyssey: 465 confirmed / 429 likely groups;
**438 names auto-ignored**; first-stage gate 2,817 → 2,348; possessives folded
(`athena's`→`athena`); user-triaged names (`ithaca` known) preserved.

**Pending:** the `likely`→**"PN"** filter bucket and the **Names** rescue view are
web/API work (co-developed) — until then, `likely` names stay in the gate tagged but
unbucketed, and a `likely`/`confirmed` name keeps any freq-tier level for display.

## Problem

Books — especially classics and fiction — flood the review list with **names** (`Homer`,
`Greece`, `Telemachus`, `Poseidon`) that aren't worth studying. They cost the reader
mental energy to sort past, one by one, for zero learning value.

Two things make it worse today:

1. The **freq fallback tier** ([03-enrichment], added 2026-06-26) assigns CEFR levels to
   proper nouns, because it's frequency-derived from Google N-grams that include names.
   Measured on the Odyssey: `telemachus`→C1, `troy`→B2, `demeter`→A1, `theseus`→A1. A name
   showing "A1" is noise in the level sort/filter.
2. **Possessive forms** (`Athena's`) survive tokenization as a *separate* word from their
   base (`athena`), because `normalizeWord` only strips edge apostrophes, not the internal
   `'s` clitic.

## Validation — measured on the Odyssey (read-only, before building)

7,905 word-groups; 2,831 unleveled ("—"). Re-tokenized the stored EPUB keeping casing and
sentence position (see "Signal", below):

- **Capitalization is high-precision.** What it flags really are names (`poseidon`,
  `calypso`, `thrace`, `lacedaemon`, `theoclymenus`). Common words (lowercase mid-sentence)
  are never flagged — the ratio gate, not the count, is what rejects them.
- **N≥2 mid-sentence caps → 362 confirmed names** auto-detected (gate −13%). **N=1 only →
  +305 more "likely names"** (a single mid-sentence capital — overwhelmingly one-mention
  minor characters/places, which classics are full of).
- **238 already-leveled words are names the freq tier mis-leveled** — the bigger, less
  obvious win is cleaning *those* out of the leveled list, not just shrinking the gate.
- **`'s`:** 133 groups end in `'s`; **123** have their base also present → collapse on strip.
- The gate's *residue* after removing names is mostly **genuinely rare real words**
  (`abolitionist`, `commonsensical`, `pentameter`) plus **extraction junk** (pronunciation-
  guide fragments `kuh-nos`, `her-mai`; hyphen splits `barley-groats`). Names are a minority
  of the gate — so name detection is worth doing, but the rare-word/junk tail is a separate
  lever (see Open questions).

## The signal: capitalization (in `@lexiprep/core`)

The signal already exists and is then thrown away — `tokenize.ts`'s `WORD_RE` captures each
word **with original casing** in the raw match, and `normalizeWord` immediately lowercases
it. A word capitalized **mid-sentence** (not sentence-initial, where everything is
capitalized regardless, and not ALL-CAPS, which is heading/emphasis noise) is strong
evidence of a proper noun.

Per normalized word, across the whole book, count its occurrences that are **not
sentence-initial and not ALL-CAPS**, split into *titlecase* vs *lowercase*. Sentence-initial
needs sentence segmentation — already required by the context-example feature in core
([03-enrichment]), so it's shared work.

**Classification** (`ratio = titlecase / (titlecase + lowercase)`):

| Condition | Class |
|---|---|
| ≥2 non-initial occurrences, ratio ≥ 0.9 | **confirmed name** |
| exactly 1 non-initial occurrence, titlecase (0 lowercase) | **likely name** |
| otherwise | normal word |

**N=2 chosen over N=1** for the confirmed tier: it demands two independent mid-sentence
sightings, so it stays safe across many books we won't hand-check. One-sighting words are
real but uncertain, so they get their own bucket rather than being trusted or discarded.

### Rejected / deferred alternatives

- **Bulk gazetteer DB (GeoNames + name lists).** Rejected as the primary mechanism: poor
  recall on *invented/transliterated* names (the ones that actually clutter fiction —
  `Telemachus`, fantasy/sci-fi coinages), and dangerous false positives where place/person
  names collide with common words (`Mark`, `Hope`, `Reading`, `Chad`, `Young`). Viable only
  as a small curated allowlist later, not a bulk import.
- **NER (wink-nlp).** Deferred as a later precision upgrade — it would also fix the
  POS-agnostic lemmatization caveat ([02-lemmatization]) since it's the same library — but
  it's heavier per book and leans on capitalization as its main proper-noun feature anyway.

## Possessive normalization (in `@lexiprep/core` `normalizeWord`)

After lowercasing/unifying apostrophes, strip a trailing `'s` (and any trailing apostrophe):
`Athena's`→`athena`, `ship's`→`ship`. Plural possessives (`dogs'`) are already handled by the
existing edge-apostrophe strip.

**Caveat:** contractions also end in `'s` (`it's`, `that's`, `let's`, `who's`). Stripping
collapses them to their stem — almost all stopwords (already hidden), so harmless; `let's`→
`let` (= "let us") is the only semantic oddity and stays a real word. Composes with name
detection: `Athena's`→`athena` then still classified a name.

## Data model & precedence

- **`book_words`** gets a proper-noun classification (`none | likely | confirmed`) — a
  **book-scoped, objective** fact set by core at processing (capitalization is measured
  within the book). It is *not* a per-user vocab choice.
- **Precedence (decided):** a **vetted** CEFR level (CEFR-J/Octanove) always wins — those
  are confirmed common words, so the word is never treated as a name. The name
  classification overrides only a **freq-tier** level or "—". Resolution order per word:
  1. vetted level present → use it; ignore classification.
  2. else confirmed name → **ignored** (below).
  3. else likely name → **PN** bucket.
  4. else → freq level, or "—".

  This is why the vetted-wins rule matters beyond tidiness: it prevents common words that
  double as names (`Mentor`, `Hope`, `Greek` — if vetted) from ever being auto-ignored.

## Review behavior

- **Confirmed names → `ignored`** (the user's choice — reuse the existing
  `user_words(status)` semantics from [05-review-and-known-words] so they leave review
  everywhere the reader expects). Detection stays **book-scoped** in `book_words`; the
  *action* of ignoring is surfaced through the existing Ignored / a "Names" view. Never
  hard-deleted → a false positive (`Greek`, a heading-cased word) is one click to rescue.
  - **Open:** store the auto-ignore as a book-scoped flag vs. write a cross-book
    `user_words(status=ignored)` row. Cross-book is desirable for unambiguous names
    (`Poseidon` is a name in any book) but risks non-vetted words that double as common
    vocabulary. The vetted-wins precedence covers most of the risk; decide at build time.
- **Likely names → "PN" bucket** in the level filter — a distinct value from "—", kept in
  the first-stage gate but labeled, so the reader clears them as a group instead of mixing
  them with genuine rare words.

## Filter & sort

- The API level filter gains a synthetic **`PN`** value derived from the classification
  column — the classification lives in its **own column**, not overloaded onto `level`
  (keeps "entity type" separate from "difficulty"). `PN` groups with the non-CEFR values
  (near "—"), as a distinct, selectable bucket.

## Scope (where each piece lives)

- **`@lexiprep/core`:** casing + sentence-position capture, the classifier, the `'s` strip.
  Cross-repo change (pipeline logic belongs in core).
- **`apps/server`:** classification column on `book_words`, auto-ignore on processing, the
  `PN` filter value.
- **`apps/web`** (co-developed with the owner): PN badge/bucket in the filter, the Names
  rescue view. Coordinate before touching.

## Open questions

- Book-scoped vs cross-book auto-ignore (above).
- Threshold tuning (N=2, ratio 0.9) across more genres/translations.
- **Extraction junk** surfaced by the measurement (pronunciation-guide fragments, hyphen
  splits) is a separate tokenizer/extraction concern, not names — worth its own pass.
- **Spanish** ([07]): capitalization rules differ (no capitalized demonyms/months/weekdays),
  generally *fewer* false positives; revisit thresholds per locale.

[01-word-extraction]: ./01-word-extraction.md
[02-lemmatization]: ./02-lemmatization.md
[03-enrichment]: ./03-enrichment.md
[05-review-and-known-words]: ./05-review-and-known-words.md
[07]: ./00-overview.md
