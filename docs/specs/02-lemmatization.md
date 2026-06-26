# 02 — Lemmatization (conjugation grouping)

Status: **Implemented.** `@lexiprep/core` computes a base-form `lemma` per word
(wink-lemmatizer, opt-in via `analyzeBook(book, { lemmatize: true })`); the app stores
`book_words.lemma`. The list is **grouped by base form** (`coalesce(lemma, word)`):
conjugations collapse into one row with summed count (`say` 396 = said+says+saying+say),
sorted/filtered/paginated over the groups; the modal lists every surface form. Levels
match on the lemma ([03-enrichment]), and `user_words` keys on it, so review/known apply
per base form. (Note: `book_words` rows stay per surface form; grouping is at query time.)

## Goal

Merge inflected forms under a base form so the list shows one entry per word rather
than `come`(162) and `came`(146) as separate rows, with counts summed under the lemma.
Each conjugation keeps its own context example so the modal can show every form in use.

## Approach

- **English: `wink-lemmatizer`** (rule-based, no model download, MIT) in core. Reduces
  nouns/verbs/adjectives to a base form. Cheap and deterministic — fits the
  framework-agnostic, zero-heavy-deps character of `@lexiprep/core`.
- Lemmatization runs over the tokens during analysis and populates each word's
  **`lemma`**. The frequency list is then presented **grouped by lemma** (counts
  summed), while the underlying `book_words` rows stay **per surface form** so each
  conjugation retains its own `count` and `example`.

So `book_words` is the surface-form grain (word, lemma, count, example, level);
grouping by `lemma` happens at query/UI time. This is what lets the modal list a
lemma's conjugations, each with "1 phrase per conjugation" ([03-enrichment]).

## Interaction with known/learning words

`user_words` matches on **lemma** ([05-review-and-known-words]). Once lemmas are
populated, classifying a lemma resolves all its conjugations at once — mark "run" known
and "ran"/"running"/"runs" all drop from the queue. Until lemmatization lands, the
match key falls back to the surface word, so the loop already works (just per surface
form).

## Open questions

- Proper nouns / names: lemmatizer will pass them through; pair with an `ignored`
  status ([05]) and/or a proper-noun heuristic so names don't clutter the queue.
- POS ambiguity: rule-based lemmatization can mislabel (e.g. "leaves" noun vs verb).
  Acceptable for v1; revisit if grouping errors are visible.
- Spanish needs a different lemmatizer (richer morphology) — deferred to the Spanish
  phase; the `lemma` column and grouping are language-agnostic.

[03-enrichment]: ./03-enrichment.md
[05-review-and-known-words]: ./05-review-and-known-words.md
