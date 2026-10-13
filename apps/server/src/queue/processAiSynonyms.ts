import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { aiWordSynonyms, books, bookWords, wordLevels } from "../db/schema.js";
import { env } from "../env.js";
import { consume, refund } from "../usage/service.js";
import { retryAfterSeconds } from "../usage/guard.js";
import { AI_SYNONYMS_SLUG } from "../usage/features.js";
import { extractContextExamples } from "../ai/context.js";
import {
  AI_SYNONYMS_JSON_SCHEMA,
  aiSynonymsOutputSchema,
  buildSynonymsPrompt,
  cleanSynonyms,
  keepNoHarder,
  SYNONYMS_PROVIDER_OPTS,
  type AiSynonymsOutput,
} from "../ai/synonymPrompt.js";
import type { chatJson } from "../ai/openrouter.js";

const MAX_CONTEXT_EXAMPLES = 5;
/** Matches the definition workers: ride out a minute-window backlog, then fail visibly. */
const MAX_DEFERRALS = 12;

export interface AiSynonymsJob {
  language: string;
  lemma: string;
  /** Who asked: the row is global, the quota is personal. */
  userId: string;
  /** The book in context, if any — only a source of example sentences. */
  bookId: string | null;
  deferrals?: number;
}

/** Injected so tests stub the LLM + requeue without any module mocking. */
export interface AiSynonymsDeps {
  chatJson: typeof chatJson;
  requeue: (job: AiSynonymsJob, opts: { startAfter: number }) => Promise<unknown>;
}

async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(aiWordSynonyms)
    .set({ status: "failed", error, updatedAt: sql`now()` })
    .where(and(eq(aiWordSynonyms.id, id), eq(aiWordSynonyms.status, "pending")));
}

/**
 * Sentences from the requester's own book, to tell which meaning is the main one.
 * Context is a prompt enhancer: a missing or foreign book just means none.
 */
async function contextExamples(job: AiSynonymsJob): Promise<string[]> {
  if (!job.bookId) return [];
  const [book] = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.id, job.bookId), eq(books.userId, job.userId)))
    .limit(1);
  if (!book) return [];

  const formRows = await db
    .select({ word: bookWords.word, example: bookWords.example })
    .from(bookWords)
    .where(
      and(
        eq(bookWords.bookId, book.id),
        sql`coalesce(${bookWords.lemma}, ${bookWords.word}) = ${job.lemma}`,
      ),
    );
  const forms = formRows.map((r) => r.word);
  const examples = await extractContextExamples(book.id, job.lemma, forms, MAX_CONTEXT_EXAMPLES);
  if (examples.length > 0) return examples;
  return [...new Set(formRows.map((r) => r.example).filter((e): e is string => !!e))].slice(
    0,
    MAX_CONTEXT_EXAMPLES,
  );
}

/** CEFR levels of the given lemmas (lowercase), from the bundled list. */
async function cefrLevels(language: string, lemmas: string[]): Promise<Map<string, string>> {
  const keys = [...new Set(lemmas.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ lemma: wordLevels.lemma, level: wordLevels.level })
    .from(wordLevels)
    .where(and(eq(wordLevels.language, language), inArray(wordLevels.lemma, keys)));
  return new Map(rows.map((r) => [r.lemma, r.level]));
}

/**
 * Background job: generate the AI synonyms for one (language, lemma) via OpenRouter.
 * Same quota discipline as the definition workers (reserve before the call, refund on
 * failure) and the same never-rethrow contract: terminal state is recorded here. An
 * empty list is a successful answer — the word has no close synonym.
 */
export async function processAiSynonyms(
  job: AiSynonymsJob,
  logger: FastifyBaseLogger,
  deps: AiSynonymsDeps,
): Promise<void> {
  const { language, lemma, userId } = job;

  const [row] = await db
    .select({ id: aiWordSynonyms.id, status: aiWordSynonyms.status })
    .from(aiWordSynonyms)
    .where(and(eq(aiWordSynonyms.language, language), eq(aiWordSynonyms.lemma, lemma)))
    .limit(1);
  if (!row || row.status !== "pending") return;

  if (!env.OPENROUTER_API_KEY) {
    await markFailed(row.id, "AI synonyms are not configured");
    return;
  }

  const quota = await consume(userId, AI_SYNONYMS_SLUG);
  if (!quota.allowed) {
    const deferrals = job.deferrals ?? 0;
    if (deferrals < MAX_DEFERRALS) {
      const startAfter = retryAfterSeconds(quota.windows);
      await deps.requeue({ ...job, deferrals: deferrals + 1 }, { startAfter });
      logger.info(
        { language, lemma, deferrals: deferrals + 1, startAfter },
        "ai-word-synonyms: over limit, deferred",
      );
    } else {
      await markFailed(row.id, "Usage limit reached");
    }
    return;
  }

  try {
    const examples = await contextExamples(job);
    const level = (await cefrLevels(language, [lemma])).get(lemma) ?? null;
    const { system, user } = buildSynonymsPrompt({ lemma, language, level, examples });
    const result = await deps.chatJson<AiSynonymsOutput>({
      model: env.OPENROUTER_DEFINITION_MODEL,
      system,
      user,
      schemaName: "word_synonyms",
      schema: AI_SYNONYMS_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3000,
      providerOpts: SYNONYMS_PROVIDER_OPTS,
    });

    const parsed = aiSynonymsOutputSchema.safeParse(result.data);
    if (!parsed.success) throw new Error("Model returned no usable synonyms list");
    const levels = await cefrLevels(language, parsed.data.synonyms);
    const kept = keepNoHarder(level, parsed.data.synonyms, levels);
    const harder = parsed.data.synonyms.filter((s) => !kept.includes(s));
    const synonyms = cleanSynonyms(lemma, kept);

    const done = await db
      .update(aiWordSynonyms)
      .set({
        status: "done",
        synonyms,
        error: null,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        updatedAt: sql`now()`,
      })
      .where(and(eq(aiWordSynonyms.id, row.id), eq(aiWordSynonyms.status, "pending")))
      .returning({ id: aiWordSynonyms.id });
    if (done.length === 0 && quota.eventId) await refund(quota.eventId);

    logger.info(
      {
        language,
        lemma,
        synonyms: synonyms.length,
        harder,
        model: result.model,
        costUsd: result.costUsd,
      },
      "ai-word-synonyms: done",
    );
  } catch (err) {
    if (quota.eventId) await refund(quota.eventId);
    await markFailed(row.id, err instanceof Error ? err.message : String(err));
    logger.error({ language, lemma, err }, "ai-word-synonyms: failed");
  }
}
