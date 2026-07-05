import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { aiDefinitions } from "../db/schema.js";
import { env } from "../env.js";
import { getBoss, AI_DEFINITION_QUEUE } from "../queue/boss.js";
import type { UserWordTransition } from "../books/service.js";

export { AI_DEFINITION_SLUG } from "../usage/features.js";

export type AiDefinitionRequestResult =
  | "enqueued" // we created (or revived) the row and queued the job
  | "pending" // a job is already queued/running — nothing to do
  | "done" // already generated — immutable, never regenerate
  | "failed" // failed earlier and retry wasn't requested
  | "disabled"; // no OPENROUTER_API_KEY configured

/**
 * Idempotent request for an AI definition of `lemma` in `book` — the single enqueue
 * path for both the auto-trigger (word marked learning) and the modal's manual button.
 * The `ON CONFLICT DO NOTHING … RETURNING` insert makes the duplicate-enqueue race
 * impossible: only the caller whose insert actually created the row sends the job.
 * A `failed` row can be revived only with `retryFailed` (the manual "Try again");
 * `done` is final by design — same prompt, same model, regenerating just burns tokens.
 */
export async function requestAiDefinition(
  book: { id: string; language: string },
  lemma: string,
  opts: { retryFailed: boolean },
): Promise<AiDefinitionRequestResult> {
  if (!env.OPENROUTER_API_KEY) return "disabled";
  const key = lemma.trim().toLowerCase();

  const inserted = await db
    .insert(aiDefinitions)
    .values({ bookId: book.id, lemma: key })
    .onConflictDoNothing({ target: [aiDefinitions.bookId, aiDefinitions.lemma] })
    .returning({ id: aiDefinitions.id });

  if (inserted.length > 0) {
    try {
      await getBoss().send(AI_DEFINITION_QUEUE, { bookId: book.id, lemma: key });
    } catch (err) {
      // Queue unavailable (best-effort startup): remove the orphan pending row so a
      // later request can start clean, then let the caller decide how loud to be.
      await db.delete(aiDefinitions).where(eq(aiDefinitions.id, inserted[0]!.id));
      throw err;
    }
    return "enqueued";
  }

  const [existing] = await db
    .select({ id: aiDefinitions.id, status: aiDefinitions.status })
    .from(aiDefinitions)
    .where(and(eq(aiDefinitions.bookId, book.id), eq(aiDefinitions.lemma, key)))
    .limit(1);
  if (!existing) return "pending"; // deleted between insert and read — treat as in-flight
  if (existing.status === "done") return "done";
  if (existing.status === "pending") return "pending";

  // status === "failed"
  if (!opts.retryFailed) return "failed";
  const revived = await db
    .update(aiDefinitions)
    .set({ status: "pending", error: null })
    .where(and(eq(aiDefinitions.id, existing.id), eq(aiDefinitions.status, "failed")))
    .returning({ id: aiDefinitions.id });
  if (revived.length === 0) return "pending"; // a concurrent retry won the flip
  try {
    await getBoss().send(AI_DEFINITION_QUEUE, { bookId: book.id, lemma: key });
  } catch (err) {
    await db
      .update(aiDefinitions)
      .set({ status: "failed", error: "Could not queue the retry" })
      .where(and(eq(aiDefinitions.id, existing.id), eq(aiDefinitions.status, "pending")));
    throw err;
  }
  return "enqueued";
}

/**
 * Auto-trigger: request a definition for every word that just *entered* `learning`
 * (transitions exclude no-op re-marks, so re-clicking Learning never re-enqueues).
 * Failures are logged, never thrown — a broken side-channel must not fail the status
 * write that triggered it.
 */
export async function triggerAiDefinitions(
  logger: FastifyBaseLogger,
  book: { id: string; language: string },
  transitions: UserWordTransition[],
): Promise<void> {
  if (!env.OPENROUTER_API_KEY) return;
  for (const t of transitions) {
    if (t.to !== "learning") continue;
    try {
      await requestAiDefinition(book, t.lemma, { retryFailed: false });
    } catch (err) {
      logger.warn(
        { err, bookId: book.id, lemma: t.lemma },
        "ai-definition: auto-trigger failed",
      );
    }
  }
}
