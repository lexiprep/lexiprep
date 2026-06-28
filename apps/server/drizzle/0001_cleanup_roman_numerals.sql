-- Drop stray Roman numerals: chapter/section numbering ("II", "xiv", "MMXXIV") that
-- isn't vocabulary. @lexiprep/core (>=0.7.0) filters them at tokenization, so this is a
-- one-time cleanup of rows created before that. We delete only tokens that parse as a
-- *valid* numeral, so real words built from the same letters ("mid", "dim", "mild",
-- "civic") survive; and we keep the handful of numerals that are also real words or
-- abbreviations ("mix" = 1009, plus cd/cv/mi/vi). Stored words are already lowercased.
-- Data-only (no schema change); runs once per environment via the drizzle journal.
DELETE FROM "book_words"
  WHERE "word" ~ '^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$'
    AND char_length("word") > 0
    AND "word" NOT IN ('mix', 'cd', 'cv', 'mi', 'vi');
--> statement-breakpoint
DELETE FROM "user_words"
  WHERE "lemma" ~ '^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$'
    AND char_length("lemma") > 0
    AND "lemma" NOT IN ('mix', 'cd', 'cv', 'mi', 'vi');
--> statement-breakpoint
DELETE FROM "word_notes"
  WHERE "lemma" ~ '^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$'
    AND char_length("lemma") > 0
    AND "lemma" NOT IN ('mix', 'cd', 'cv', 'mi', 'vi');
