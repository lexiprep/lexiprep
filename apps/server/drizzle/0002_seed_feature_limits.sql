-- Seed the initial usage policy for the AI contextual-definition feature (spec 13):
-- 5 calls/minute AND 120 calls/hour. The tables themselves are created by `db:push`
-- (which runs before `db:migrate` at startup), so this migration only seeds policy
-- rows. Idempotent + re-runnable: upsert on (slug, window). Change the policy later
-- with another custom migration (bump max_count, or DELETE a window's row).
INSERT INTO "feature_limits" ("slug", "window", "max_count") VALUES
  ('ai-word-definition-from-context', 'minute', 5),
  ('ai-word-definition-from-context', 'hour', 120)
ON CONFLICT ("slug", "window") DO UPDATE
  SET "max_count" = EXCLUDED."max_count", "updated_at" = now();
