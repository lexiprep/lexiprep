-- Drop single-character "words": "a"/"I", OCR or list-bullet debris, and split-off
-- clitics. These aren't words worth tracking. @lexiprep/core (>=0.5.0) filters them at
-- tokenization, so this is a one-time cleanup of rows created before that. Data-only
-- (no schema change); runs once per environment via the drizzle migration journal.
DELETE FROM "book_words" WHERE char_length("word") < 2;
--> statement-breakpoint
DELETE FROM "user_words" WHERE char_length("lemma") < 2;
--> statement-breakpoint
DELETE FROM "word_notes" WHERE char_length("lemma") < 2;
