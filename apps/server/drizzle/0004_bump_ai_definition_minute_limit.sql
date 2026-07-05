-- The AI-definition queue defers over-limit jobs instead of dropping them (throttle-
-- through), so the minute window is a pacing knob, not a hard cap. 5/min made batch
-- review feel slow; 10/min drains a typical flagged batch in about a minute while the
-- hour window (120) still bounds spend.
UPDATE "feature_limits"
SET "max_count" = 10, "updated_at" = now()
WHERE "slug" = 'ai-word-definition-from-context' AND "window" = 'minute';
