import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { aiDefinitions, books, bookWords, wordSenses } from "../db/schema.js";
import { env } from "../env.js";
import { consume, refund } from "../usage/service.js";
import { retryAfterSeconds } from "../usage/guard.js";
import { AI_DEFINITION_SLUG } from "../usage/features.js";
import { extractContextExamples } from "../ai/context.js";
import {
  AI_DEFINITION_JSON_SCHEMA,
  aiDefinitionOutputSchema,
  buildDefinitionPrompt,
  DEFINITION_PROVIDER_OPTS,
  MAX_MEANINGS,
  type AiDefinitionOutput,
} from "../ai/definitionPrompt.js";
import type { chatJson } from "../ai/openrouter.js";

const MAX_CONTEXT_EXAMPLES = 5;
/**
 * Over-limit jobs defer (throttle-through) rather than drop. 12 deferrals rides out a
 * full minute-window backlog with margin; a job still over-limit after that (hour
 * window exhausted, repeatedly) fails visibly instead of haunting the queue.
 */
const MAX_DEFERRALS = 12;

export interface AiDefinitionJob {
  bookId: string;
  lemma: string;
  /** How many times this job was re-queued because the usage limit was exhausted. */
  deferrals?: number;
}

/** Injected so tests stub the LLM + requeue without any module mocking. */
export interface AiDefinitionDeps {
  chatJson: typeof chatJson;
  requeue: (job: AiDefinitionJob, opts: { startAfter: number }) => Promise<unknown>;
}

async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(aiDefinitions)
    .set({ status: "failed", error, updatedAt: sql`now()` })
    .where(and(eq(aiDefinitions.id, id), eq(aiDefinitions.status, "pending")));
}

/**
 * Background job: generate the AI contextual definition for one (book, lemma) via
 * OpenRouter. Quota is reserve+refund (guard.ts's prescription for real LLM calls):
 * `consume()` *before* the call, `refund()` on any failure after it. Like processBook,
 * this catches everything and records terminal state itself — it never rethrows, so
 * pg-boss retry semantics don't apply; deferral/retry is explicit in the flow.
 */
export async function processAiDefinition(
  job: AiDefinitionJob,
  logger: FastifyBaseLogger,
  deps: AiDefinitionDeps,
): Promise<void> {
  const { bookId, lemma } = job;

  const [row] = await db
    .select({ id: aiDefinitions.id, status: aiDefinitions.status })
    .from(aiDefinitions)
    .where(and(eq(aiDefinitions.bookId, bookId), eq(aiDefinitions.lemma, lemma)))
    .limit(1);
  // Gone (book deleted → cascade) or already resolved (done is immutable; a failed row
  // only re-runs when the manual retry flips it back to pending and re-sends).
  if (!row || row.status !== "pending") return;

  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) {
    await markFailed(row.id, "Book not found");
    return;
  }
  if (!env.OPENROUTER_API_KEY) {
    await markFailed(row.id, "AI definitions are not configured");
    return;
  }

  // Reserve quota before the expensive call (never consume after — that's the race).
  const quota = await consume(book.userId, AI_DEFINITION_SLUG);
  if (!quota.allowed) {
    const deferrals = job.deferrals ?? 0;
    if (deferrals < MAX_DEFERRALS) {
      const startAfter = retryAfterSeconds(quota.windows);
      await deps.requeue({ bookId, lemma, deferrals: deferrals + 1 }, { startAfter });
      logger.info(
        { bookId, lemma, deferrals: deferrals + 1, startAfter },
        "ai-definition: over limit, deferred",
      );
    } else {
      await markFailed(row.id, "Usage limit reached");
    }
    return;
  }

  try {
    const formRows = await db
      .select({ word: bookWords.word, example: bookWords.example })
      .from(bookWords)
      .where(
        and(
          eq(bookWords.bookId, bookId),
          sql`coalesce(${bookWords.lemma}, ${bookWords.word}) = ${lemma}`,
        ),
      );
    const forms = formRows.map((r) => r.word);

    let examples = await extractContextExamples(bookId, lemma, forms, MAX_CONTEXT_EXAMPLES);
    if (examples.length === 0) {
      // Fall back to the stored first-occurrence sentences (one per surface form).
      examples = [
        ...new Set(formRows.map((r) => r.example).filter((e): e is string => !!e)),
      ].slice(0, MAX_CONTEXT_EXAMPLES);
    }

    const { system, user } = buildDefinitionPrompt({
      lemma,
      forms,
      bookTitle: book.title,
      bookAuthor: book.author,
      language: book.language,
      examples,
    });
    const result = await deps.chatJson<AiDefinitionOutput>({
      model: env.OPENROUTER_DEFINITION_MODEL,
      system,
      user,
      schemaName: "word_definitions",
      schema: AI_DEFINITION_JSON_SCHEMA as unknown as Record<string, unknown>,
      // Cap, not target: the meanings are tiny but low-effort reasoning tokens count
      // as output too.
      maxTokens: 3000,
      providerOpts: DEFINITION_PROVIDER_OPTS,
    });

    const parsed = aiDefinitionOutputSchema.safeParse(result.data);
    const meanings = parsed.success ? parsed.data.meanings.slice(0, MAX_MEANINGS) : [];
    if (meanings.length === 0) throw new Error("Model returned no usable meanings");

    const updated = await db.transaction(async (tx) => {
      // The status guard makes a freak double-run harmless: the loser writes nothing.
      const done = await tx
        .update(aiDefinitions)
        .set({
          status: "done",
          error: null,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          updatedAt: sql`now()`,
        })
        .where(and(eq(aiDefinitions.id, row.id), eq(aiDefinitions.status, "pending")))
        .returning({ id: aiDefinitions.id });
      if (done.length === 0) return false;
      await tx.insert(wordSenses).values(
        meanings.map((m, idx) => ({
          language: book.language,
          lemma,
          bookId,
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
      { bookId, lemma, meanings: meanings.length, model: result.model, costUsd: result.costUsd },
      "ai-definition: done",
    );
  } catch (err) {
    if (quota.eventId) await refund(quota.eventId);
    await markFailed(row.id, err instanceof Error ? err.message : String(err));
    logger.error({ bookId, lemma, err }, "ai-definition: failed");
  }
}
