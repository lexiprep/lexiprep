# 01 — Word extraction (EPUB → frequency list)

Status: **Implemented** in the separate `lexiprep-core` repo (`@lexiprep/core`). The first deliverable.

## Goal

Given an EPUB, produce a list of distinct words with occurrence counts, sorted
most-frequent first, with optional filtering by chapter range, stopwords, and
minimum length. This is the foundation every later phase builds on.

## Decisions

### EPUB only (v1)

EPUB is structured, reflowable XHTML — clean text with real content-document
boundaries, ideal for the frequency pipeline and the page-range filter. PDF
(messy: hyphenation, columns, no logical pages) and MOBI are deferred.

### Custom EPUB reader over a third-party epub library

`readEpub()` is implemented directly on `jszip` + `fast-xml-parser` +
`node-html-parser` rather than depending on an epub-parsing package. Reasons:

- Full control over text-extraction quality (tokenization and, later, sentence
  segmentation depend on it).
- No reliance on a possibly-unmaintained wrapper; this is core, readable code in
  an open-source project.
- Portable: `jszip` runs in the browser too, so the core could run client-side
  later.

It follows the OPF spine for reading order, resolves manifest hrefs (handling
`../`, fragments, percent-encoding, case-insensitive zip lookup), strips
script/style and markup, and best-effort resolves chapter titles from the EPUB2
NCX or EPUB3 nav document (titles are optional — a malformed ToC never fails the
read). DRM is out of scope.

### "Filter by pages" maps to chapter ranges

EPUB is reflowable and has **no fixed physical pages**. So page filtering is
expressed over content documents (spine items) via `fromChapter`/`toChapter`
(0-based, inclusive, clamped to bounds). Two later refinements are possible
(see open questions): approximate pages by token count, or real print-page
mapping when an EPUB3 `page-list` nav is present.

### Tokenization rules

A token is a run of letters (`\p{L}`, any script — Spanish accents work now) that
may contain internal apostrophes or hyphens, but never leading/trailing
punctuation or digits:

- `don't`, `it's`, `O'Brien` stay whole; curly `’` is unified with straight `'`
  so `don't` and `don't` count as one word.
- `well-known`, `co-operate` stay whole.
- Pure numbers and digits are dropped (`2024`, `3` → nothing).
- Everything is lowercased.

A Unicode regex is used rather than `Intl.Segmenter` for predictable apostrophe/
hyphen handling; both EN and ES are space-delimited so this is sufficient and
locale-independent.

### Stopwords

A conservative English function-word set (articles, prepositions, pronouns,
auxiliaries, modals, conjunctions, basic determiners) lives in
`stopwords/english.ts`. It targets grammatical words, **not** common content
words a learner might still want (`time`, `people`, `first` are kept). Filtering
is opt-in per call; the CLI enables it by default.

### Sorting

Descending by count, ties broken alphabetically (stable, deterministic output).

## Public API (`@lexiprep/core`)

```ts
readEpub(input: Buffer | Uint8Array | ArrayBuffer): Promise<EpubBook>
//   EpubBook = { metadata, chapters: { id, href, order, title?, text }[] }

tokenize(text: string): string[]            // normalized word tokens
normalizeWord(raw: string): string

analyzeBook(book: EpubBook, options?: CountOptions & ChapterRange): BookAnalysis
//   BookAnalysis = { metadata, chapterCount, analyzedRange,
//                    totalTokens, uniqueWords, frequencies: { word, count }[] }
countWords(text: string, options?: CountOptions): WordFrequency[]

// CountOptions: { minLength?, excludeStopwords?, stopwords? }
// ChapterRange: { fromChapter?, toChapter? }

ENGLISH_STOPWORDS: ReadonlySet<string>
```

### CLI

```
# in the lexiprep-core repo:
pnpm analyze <book.epub> \
  [--top N] [--from C] [--to C] [--min-length N] [--keep-stopwords] [--json]
```

Defaults to top 30 with stopwords excluded. `--json` emits the full analysis.

## Validation

23 unit tests (`vitest`) cover tokenization edge cases (contractions, hyphens,
accents, digits), counting/sorting/filtering, chapter-range clamping, and an
end-to-end EPUB read against an in-memory fixture (EPUB2-NCX and EPUB3-nav
variants, markup/script/style stripping).

Manually validated against a real book — *The Adventures of Sherlock Holmes*
(Project Gutenberg #1661): 108,010 tokens, 8,301 unique words after stopword
removal, metadata and 15 chapters parsed correctly.

## Open questions / next steps

- **Conjugation grouping (phase 2).** Real output shows `come`(162) and
  `came`(146) as separate entries — lemmatization should merge inflections under a
  base form and sum counts. Plan: `wink-lemmatizer`. See `02-lemmatization.md`.
- **Front/back-matter noise.** The Gutenberg run surfaced `gutenberg`(112) from
  license boilerplate. Consider detecting/skipping non-narrative sections
  (license, ToC, copyright) — by spine `linear="no"`, by `epub:type` landmarks
  (cover/frontmatter/backmatter), or heuristics.
- **Approximate pages.** Optionally expose a token-based page model (~250–300
  words/page) and/or honor an EPUB3 `page-list` when present, so "filter by pages"
  can mean print pages, not just chapters.
- **Proper nouns / abbreviations.** `holmes`, `mr` rank high. Later phases (level
  tagging, definition lookup) will naturally down-rank or flag these; consider a
  proper-noun filter toggle.
- **Hyphenation across line breaks.** Not handled; EPUB text rarely hard-wraps, so
  deferred.
