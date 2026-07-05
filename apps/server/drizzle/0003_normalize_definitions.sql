-- Normalize the dictionary: copy `definitions` (one jsonb senses array per lemma) into
-- `word_senses` (one row per sense) and record the Free-Dictionary fetch markers that
-- replace the old empty-senses negative cache. The tables themselves are created by
-- `db:push`, which runs before `db:migrate` at startup; the old `definitions` table is
-- kept (deprecated, unread) and dropped in a follow-up release. Idempotent: guarded by
-- NOT EXISTS / ON CONFLICT, so a partial run can be repeated safely.

INSERT INTO "word_senses" ("language", "lemma", "book_id", "idx", "pos", "gloss", "example", "source", "ai")
SELECT
  d."language",
  d."lemma",
  NULL,
  (s.ord - 1)::int,
  coalesce(s.value->>'pos', ''),
  s.value->>'gloss',
  -- Examples are usually strings, but OEWN sometimes stores attributed quotes {text, source}.
  CASE jsonb_typeof(s.value->'example')
    WHEN 'string' THEN s.value->>'example'
    WHEN 'object' THEN s.value->'example'->>'text'
    ELSE NULL
  END,
  d."source",
  false
FROM "definitions" d
CROSS JOIN LATERAL jsonb_array_elements(d."senses") WITH ORDINALITY AS s(value, ord)
WHERE s.value->>'gloss' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "word_senses" ws
    WHERE ws."language" = d."language" AND ws."lemma" = d."lemma" AND ws."book_id" IS NULL
  );
--> statement-breakpoint

-- Every freedict row — including the `[]` negatives — means "the API was asked and
-- answered definitively"; that fact now lives in definition_fetches.
INSERT INTO "definition_fetches" ("language", "lemma")
SELECT d."language", d."lemma"
FROM "definitions" d
WHERE d."source" = 'freedict'
ON CONFLICT ("language", "lemma") DO NOTHING;
