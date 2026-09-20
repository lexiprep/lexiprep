import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { aiWordDefinitions, wordSenses } from "../db/schema.js";
import { env } from "../env.js";
import { consume, refund } from "../usage/service.js";
import { retryAfterSeconds } from "../usage/guard.js";
import { AI_GENERAL_DEFINITION_SLUG } from "../usage/features.js";
import {
  AI_GENERAL_DEFINITION_JSON_SCHEMA,
  aiDefinitionOutputSchema,
  buildGeneralDefinitionPrompt,
  DEFINITION_PROVIDER_OPTS,
  MAX_MEANINGS,
  type AiDefinitionOutput,
} from "../ai/definitionPrompt.js";
import type { chatJson } from "../ai/openrouter.js";

/** Matches the contextual worker: ride out a minute-window backlog, then fail visibly. */
const MAX_DEFERRALS = 12;

export interface GeneralAiDefinitionJob {
  language: string;
  lemma: string;
  /**
   * Who asked. The row itself is global — the word means the same for everyone — but
   * the quota is personal, so the requester pays for the generation the rest reuse.
   */
  userId: string;
  deferrals?: number;
}

/** Injected so tests stub the LLM + requeue without any module mocking. */
export interface GeneralAiDefinitionDeps {
  chatJson: typeof chatJson;
  requeue: (job: GeneralAiDefinitionJob, opts: { startAfter: number }) => Promise<unknown>;
}

async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(aiWordDefinitions)
    .set({ status: "failed", error, updatedAt: sql`now()` })
    .where(and(eq(aiWordDefinitions.id, id), eq(aiWordDefinitions.status, "pending")));
}

/**
 * Background job: generate the context-free AI definition for one (language, lemma) via
 * OpenRouter — the library-wide twin of {@link processAiDefinition}, for the word modal
 * opened outside any single book. Same quota discipline (reserve before the call, refund
 * on failure) and the same never-rethrow contract: terminal state is recorded here.
 */
export async function processGeneralAiDefinition(
  job: GeneralAiDefinitionJob,
  logger: FastifyBaseLogger,
  deps: GeneralAiDefinitionDeps,
): Promise<void> {
  const { language, lemma, userId } = job;

  const [row] = await db
    .select({ id: aiWordDefinitions.id, status: aiWordDefinitions.status })
    .from(aiWordDefinitions)
    .where(
      and(eq(aiWordDefinitions.language, language), eq(aiWordDefinitions.lemma, lemma)),
    )
    .limit(1);
  // Already resolved (done is immutable; a failed row only re-runs via the manual retry).
  if (!row || row.status !== "pending") return;

  if (!env.OPENROUTER_API_KEY) {
    await markFailed(row.id, "AI definitions are not configured");
    return;
  }

  const quota = await consume(userId, AI_GENERAL_DEFINITION_SLUG);
  if (!quota.allowed) {
    const deferrals = job.deferrals ?? 0;
    if (deferrals < MAX_DEFERRALS) {
      const startAfter = retryAfterSeconds(quota.windows);
      await deps.requeue({ language, lemma, userId, deferrals: deferrals + 1 }, { startAfter });
      logger.info(
        { language, lemma, deferrals: deferrals + 1, startAfter },
        "ai-word-definition: over limit, deferred",
      );
    } else {
      await markFailed(row.id, "Usage limit reached");
    }
    return;
  }

  try {
    const { system, user } = buildGeneralDefinitionPrompt({ lemma, language });
    const result = await deps.chatJson<AiDefinitionOutput>({
      model: env.OPENROUTER_DEFINITION_MODEL,
      system,
      user,
      schemaName: "word_meanings",
      schema: AI_GENERAL_DEFINITION_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3000,
      providerOpts: DEFINITION_PROVIDER_OPTS,
    });

    const parsed = aiDefinitionOutputSchema.safeParse(result.data);
    const meanings = parsed.success ? parsed.data.meanings.slice(0, MAX_MEANINGS) : [];
    if (meanings.length === 0) throw new Error("Model returned no usable meanings");

    const updated = await db.transaction(async (tx) => {
      const done = await tx
        .update(aiWordDefinitions)
        .set({
          status: "done",
          error: null,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          updatedAt: sql`now()`,
        })
        .where(and(eq(aiWordDefinitions.id, row.id), eq(aiWordDefinitions.status, "pending")))
        .returning({ id: aiWordDefinitions.id });
      if (done.length === 0) return false; // a double-run lost the race; it writes nothing
      // Null bookId + ai = true: global, and kept out of the dictionary's lane.
      await tx.insert(wordSenses).values(
        meanings.map((m, idx) => ({
          language,
          lemma,
          bookId: null,
          idx,
          pos: m.pos,
          gloss: m.meaning,
          source: "ai",
          ai: true,
        })),
      );
      return true;
    });
    if (!updated && quota.eventId) await refund(quota.eventId);

    logger.info(
      { language, lemma, meanings: meanings.length, model: result.model, costUsd: result.costUsd },
      "ai-word-definition: done",
    );
  } catch (err) {
    if (quota.eventId) await refund(quota.eventId);
    await markFailed(row.id, err instanceof Error ? err.message : String(err));
    logger.error({ language, lemma, err }, "ai-word-definition: failed");
  }
}

/** Senses already stored for this (language, lemma) — used to skip a needless job. */
export async function hasGlobalAiSenses(language: string, lemma: string): Promise<boolean> {
  const [row] = await db
    .select({ id: wordSenses.id })
    .from(wordSenses)
    .where(
      and(
        eq(wordSenses.language, language),
        eq(wordSenses.lemma, lemma),
        isNull(wordSenses.bookId),
        eq(wordSenses.ai, true),
      ),
    )
    .limit(1);
  return !!row;
}
