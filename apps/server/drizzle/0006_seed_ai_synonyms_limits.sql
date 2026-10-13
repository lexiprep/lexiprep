-- Usage policy for AI synonyms (spec 15). Synonyms are requested on their own right after
-- each AI definition, so the minute window matches the contextual definition's (10) and a
-- flagged review batch drains at the same pace; the hour window bounds spend. Same shape
-- as 0005 — idempotent upsert on (slug, window), policy adjustable in the DB.
INSERT INTO "feature_limits" ("slug", "window", "max_count") VALUES
  ('ai-word-synonyms', 'minute', 10),
  ('ai-word-synonyms', 'hour', 120)
ON CONFLICT ("slug", "window") DO UPDATE
  SET "max_count" = EXCLUDED."max_count", "updated_at" = now();
