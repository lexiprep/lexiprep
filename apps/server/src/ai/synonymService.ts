import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { aiWordSynonyms } from "../db/schema.js";
import { env } from "../env.js";
import { getBoss, AI_SYNONYMS_QUEUE } from "../queue/boss.js";
import type { AiDefinitionRequestResult } from "./definitionService.js";

export { AI_SYNONYMS_SLUG } from "../usage/features.js";

/**
 * Idempotent request for the AI synonyms of `lemma` (spec 15) — the single enqueue path
 * for both the automatic follow-up to an AI definition and the modal's button. Same
 * discipline as the definition requests: the conflicting insert decides who enqueues,
 * `done` is final, and `failed` revives only with `retryFailed`. The row is global;
 * `userId` rides on the job because the quota is personal, and `bookId` (when a book is
 * in context) lends its sentences to the prompt.
 */
export async function requestAiSynonyms(
  language: string,
  lemma: string,
  userId: string,
  bookId: string | null,
  opts: { retryFailed: boolean },
): Promise<AiDefinitionRequestResult> {
  if (!env.OPENROUTER_API_KEY) return "disabled";
  const key = lemma.trim().toLowerCase();
  const job = { language, lemma: key, userId, bookId };

  const inserted = await db
    .insert(aiWordSynonyms)
    .values({ language, lemma: key })
    .onConflictDoNothing({ target: [aiWordSynonyms.language, aiWordSynonyms.lemma] })
    .returning({ id: aiWordSynonyms.id });

  if (inserted.length > 0) {
    try {
      await getBoss().send(AI_SYNONYMS_QUEUE, job);
    } catch (err) {
      await db.delete(aiWordSynonyms).where(eq(aiWordSynonyms.id, inserted[0]!.id));
      throw err;
    }
    return "enqueued";
  }

  const [existing] = await db
    .select({ id: aiWordSynonyms.id, status: aiWordSynonyms.status })
    .from(aiWordSynonyms)
    .where(and(eq(aiWordSynonyms.language, language), eq(aiWordSynonyms.lemma, key)))
    .limit(1);
  if (!existing) return "pending"; // deleted between insert and read — treat as in-flight
  if (existing.status === "done") return "done";
  if (existing.status === "pending") return "pending";

  if (!opts.retryFailed) return "failed";
  const revived = await db
    .update(aiWordSynonyms)
    .set({ status: "pending", error: null })
    .where(and(eq(aiWordSynonyms.id, existing.id), eq(aiWordSynonyms.status, "failed")))
    .returning({ id: aiWordSynonyms.id });
  if (revived.length === 0) return "pending"; // a concurrent retry won the flip
  try {
    await getBoss().send(AI_SYNONYMS_QUEUE, job);
  } catch (err) {
    await db
      .update(aiWordSynonyms)
      .set({ status: "failed", error: "Could not queue the retry" })
      .where(and(eq(aiWordSynonyms.id, existing.id), eq(aiWordSynonyms.status, "pending")));
    throw err;
  }
  return "enqueued";
}
