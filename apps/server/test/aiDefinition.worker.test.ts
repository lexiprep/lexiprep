import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../src/db/client.js";
import { env } from "../src/env.js";
import { processAiDefinition, type AiDefinitionDeps } from "../src/queue/processAiDefinition.js";
import type { chatJson, ChatJsonResult } from "../src/ai/openrouter.js";
import type { AiDefinitionOutput } from "../src/ai/definitionPrompt.js";
import {
  addAiDefinition,
  addBookWords,
  addFeatureLimit,
  createBook,
  createUser,
} from "./helpers/db.js";

const { aiDefinitions, wordSenses, featureUsageEvents } = schema;

const SLUG = "ai-word-definition-from-context";

const logger = {
  info() {},
  warn() {},
  error() {},
} as unknown as FastifyBaseLogger;

function okResult(meanings: AiDefinitionOutput["meanings"]): ChatJsonResult<AiDefinitionOutput> {
  return {
    data: { meanings },
    inputTokens: 321,
    outputTokens: 45,
    costUsd: 0.00012,
    model: "google/gemini-3.1-flash-lite",
  };
}

function makeDeps() {
  const chat = vi.fn().mockResolvedValue(
    okResult([
      { pos: "noun", meaning: "a large sea animal" },
      { pos: "verb", meaning: "to hit something very hard" },
    ]),
  );
  const requeue = vi.fn().mockResolvedValue(undefined);
  const deps: AiDefinitionDeps = {
    chatJson: chat as unknown as typeof chatJson,
    requeue,
  };
  return { chat, requeue, deps };
}

let userId: string;
let bookId: string;
const originalKey = env.OPENROUTER_API_KEY;

beforeEach(async () => {
  env.OPENROUTER_API_KEY = "test-key"; // env is parsed once at import; mutate + restore
  userId = await createUser();
  const book = await createBook(userId, {
    title: "Moby-Dick",
    author: "Herman Melville",
  });
  bookId = book.id;
  await addBookWords(bookId, [
    { word: "whale", lemma: "whale", count: 3, example: "The whale surfaced at dawn." },
    { word: "whales", lemma: "whale", count: 2, example: "Whales sang in the deep." },
  ]);
  await addFeatureLimit(SLUG, "minute", 10);
});

afterEach(() => {
  env.OPENROUTER_API_KEY = originalKey;
});

async function jobRow() {
  const [row] = await db
    .select()
    .from(aiDefinitions)
    .where(and(eq(aiDefinitions.bookId, bookId), eq(aiDefinitions.lemma, "whale")));
  return row;
}

const usageCount = async () =>
  (await db.select().from(featureUsageEvents).where(eq(featureUsageEvents.slug, SLUG))).length;

describe("processAiDefinition", () => {
  it("generates, stores normalized ai senses, and records model/tokens/cost + one usage event", async () => {
    await addAiDefinition(bookId, "whale");
    const { chat, deps } = makeDeps();

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);

    const row = await jobRow();
    expect(row).toMatchObject({
      status: "done",
      error: null,
      model: "google/gemini-3.1-flash-lite",
      inputTokens: 321,
      outputTokens: 45,
    });
    expect(row!.costUsd).toBeCloseTo(0.00012);

    const senses = await db
      .select()
      .from(wordSenses)
      .where(and(eq(wordSenses.bookId, bookId), eq(wordSenses.lemma, "whale")))
      .orderBy(asc(wordSenses.idx));
    expect(senses).toHaveLength(2);
    expect(senses[0]).toMatchObject({
      pos: "noun",
      gloss: "a large sea animal",
      source: "ai",
      ai: true,
      language: "en",
    });

    expect(await usageCount()).toBe(1);

    // The prompt carried the book, the surface forms, and the context block.
    const call = chat.mock.calls[0]![0];
    expect(call.user).toContain('Book: "Moby-Dick" by Herman Melville');
    expect(call.user).toContain("whale, whales");
    expect(call.user).toContain("<context_examples>");
    expect(call.user).toContain("The whale surfaced at dawn.");
    expect(call.system).toContain("at most 3");
  });

  it("defers (requeue with startAfter) when over the limit, leaving the row pending", async () => {
    await db.delete(schema.featureLimits).where(eq(schema.featureLimits.slug, SLUG));
    await addFeatureLimit(SLUG, "minute", 0);
    await addAiDefinition(bookId, "whale");
    const { chat, requeue, deps } = makeDeps();

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);

    expect(chat).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledTimes(1);
    const [payload, opts] = requeue.mock.calls[0]!;
    expect(payload).toEqual({ bookId, lemma: "whale", deferrals: 1 });
    expect(opts.startAfter).toBeGreaterThan(0);
    expect((await jobRow())!.status).toBe("pending");
    expect(await usageCount()).toBe(0);
  });

  it("fails instead of deferring forever once the deferral cap is hit", async () => {
    await db.delete(schema.featureLimits).where(eq(schema.featureLimits.slug, SLUG));
    await addFeatureLimit(SLUG, "minute", 0);
    await addAiDefinition(bookId, "whale");
    const { requeue, deps } = makeDeps();

    await processAiDefinition({ bookId, lemma: "whale", deferrals: 12 }, logger, deps);

    expect(requeue).not.toHaveBeenCalled();
    expect(await jobRow()).toMatchObject({ status: "failed", error: "Usage limit reached" });
  });

  it("marks failed and refunds the reserved use when the LLM call throws", async () => {
    await addAiDefinition(bookId, "whale");
    const { chat, deps } = makeDeps();
    chat.mockRejectedValue(new Error("model exploded"));

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);

    expect(await jobRow()).toMatchObject({ status: "failed", error: "model exploded" });
    expect(await usageCount()).toBe(0); // reserved, then refunded
  });

  it("marks failed and refunds when the model returns no usable meanings", async () => {
    await addAiDefinition(bookId, "whale");
    const { chat, deps } = makeDeps();
    chat.mockResolvedValue(okResult([]));

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);

    expect(await jobRow()).toMatchObject({ status: "failed" });
    expect(await usageCount()).toBe(0);
  });

  it("caps stored meanings at 3 even if the model over-delivers", async () => {
    await addAiDefinition(bookId, "whale");
    const { chat, deps } = makeDeps();
    chat.mockResolvedValue(
      okResult([
        { pos: "noun", meaning: "m1" },
        { pos: "noun", meaning: "m2" },
        { pos: "noun", meaning: "m3" },
        { pos: "noun", meaning: "m4" },
      ]),
    );

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);

    const senses = await db
      .select()
      .from(wordSenses)
      .where(and(eq(wordSenses.bookId, bookId), eq(wordSenses.ai, true)));
    expect(senses).toHaveLength(3);
  });

  it("is a no-op for an already-done row (immutability) and for a missing row", async () => {
    await addAiDefinition(bookId, "whale", "done");
    const { chat, deps } = makeDeps();

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);
    await processAiDefinition({ bookId, lemma: "unseen" }, logger, deps);

    expect(chat).not.toHaveBeenCalled();
    expect(await usageCount()).toBe(0);
  });

  it("fails cleanly when the API key is not configured", async () => {
    env.OPENROUTER_API_KEY = "";
    await addAiDefinition(bookId, "whale");
    const { chat, deps } = makeDeps();

    await processAiDefinition({ bookId, lemma: "whale" }, logger, deps);

    expect(chat).not.toHaveBeenCalled();
    expect(await jobRow()).toMatchObject({
      status: "failed",
      error: "AI definitions are not configured",
    });
  });
});
