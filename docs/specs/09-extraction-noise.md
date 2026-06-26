# 09 — Extraction noise cleanup

Reducing the junk that lands in a book's word list (non-words that aren't worth
studying). Tracks what's done and what's an open, optional follow-up.

## Done (shipped)

Both changes live in `@lexiprep/core` and take effect on (re)processing a book.

1. **Hyphen splitting** (`core` 0.3.0). Hyphenated tokens are split into their
   parts instead of kept whole. In books they're overwhelmingly translator
   compounds (`wine-dark`, `bright-eyed`, `rosy-fingered`) and pronunciation
   respellings — noise as whole tokens, while their parts are real, CEFR-leveled
   words. In The Odyssey, 703 of 717 distinct hyphenated tokens had no level;
   splitting recovers `wine`, `dark`, `bright`, etc. and accrues their counts.

2. **Pronunciation respelling strip** (`core` 0.4.0, `cleanText`). Glossaries /
   "pronunciation keys" spell names phonetically in parentheses with an acute
   stress accent — `Achilles (a-kil´-eez)`, `Acroneüs (ak-ro´-nee-us)`. These
   tokenized into pure junk syllables (`kil`, `eez`, `tus`, `nee`). `cleanText`
   strips any parenthetical containing U+00B4 (´) before tokenizing. Prose
   parentheticals never carry that mark, so the match is precise; it generalizes
   to any book using this common convention. Removed all 392 respellings in The
   Odyssey.

Why a dictionary filter alone can't do this: the respelling syllables collide
with obscure real words (`tee` = golf tee, `nee` = née, `lee`, `yus`, `ee` are
all genuine WordNet entries), so "is it a word?" can't separate them from junk.
The source-structure signal (the stress mark) can.

## Residual junk after both fixes (The Odyssey)

~52 short (≤4 char) no-level, not-in-dictionary tokens remain, almost all at
count 1–3:

- **Names** (`irus`, `gaia`, `styx`, `ino`, `otus`, `moly`, …) — already
  auto-ignored by proper-noun detection (spec 06). Not a problem.
- **Pronunciation-key symbols** (`oo`, `zh`, `ehr`, `ay`, `oy`) — from the
  glossary's "oo as in boot" key list, which is plain prose (no parentheses,
  no stress mark), so the strip doesn't catch it. Count 1 each.
- **Bibliographic bits** from front/back matter (`lccn`, `lcc`, `pbk`, `ebk`,
  `npr`, `gov`). Count 1–2.
- A few foreign words (`deus`, `dios`, `día`, `abbé`).

This long tail is handled by existing mechanisms: names auto-ignore, and the
batch **Ignore rest** / **Complete batch** actions clear count-1 stragglers in
seconds.

## Open follow-up (optional — needs a decision)

If the residual tail is still annoying, the next lever is **excluding reference
sections from extraction**: a book's Glossary / Index / Notes / Acknowledgments
aren't really "the book," and they're the source of nearly all the remaining
junk (pronunciation-key symbols, bibliographic bits). Two ways:

- **Automatic** — skip sections whose title matches `glossary|index|notes|
  acknowledg|bibliography|copyright` during extraction in core. Simple, but
  title-matching is a heuristic and could occasionally over-skip.
- **Per-book section range** — the model already supports a section/page range
  (`analyzeBook({from,to})`); expose it in the UI so the user trims front/back
  matter per book. More control, more UI.

A secondary lever is a **dictionary soft-filter**: hide (don't delete) words
with no CEFR level and no real WordNet sense by default, reversible via the
View selector. Catches OCR/foreign bits but is imperfect on the word-colliders
above, so it must be a soft hide, not an auto-ignore.

Recommendation: leave as-is for now (the tail is small and easy to bulk-clear);
revisit automatic reference-section exclusion if it proves recurrent across
books. No action taken pending a decision.
