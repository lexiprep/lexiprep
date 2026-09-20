-- Usage policy for the context-free AI definition (the library-wide word modal).
-- Metered apart from the contextual one: the call is cheaper (no book context) and the
-- result is global, so a generation any user pays for serves everyone afterwards. Same
-- shape as 0002 — idempotent upsert on (slug, window), policy adjustable in the DB.
INSERT INTO "feature_limits" ("slug", "window", "max_count") VALUES
  ('ai-word-definition-general', 'minute', 10),
  ('ai-word-definition-general', 'hour', 120)
ON CONFLICT ("slug", "window") DO UPDATE
  SET "max_count" = EXCLUDED."max_count", "updated_at" = now();
