import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { db, schema } from "../src/db/client.js";
import { env } from "../src/env.js";
import { requestGeneralAiDefinition } from "../src/ai/definitionService.js";
import {
  processGeneralAiDefinition,
  type GeneralAiDefinitionDeps,
} from "../src/queue/processGeneralAiDefinition.js";
import { getDictionarySenses, getGlobalAiSenses } from "../src/dictionary/service.js";
import type { ChatJsonResult } from "../src/ai/openrouter.js";
import type { AiDefinitionOutput } from "../src/ai/definitionPrompt.js";
import { addBookWords, addDefinition, addFeatureLimit, createBook, createUser } from "./helpers/db.js";

// The queue isn't started in tests; stub the boss so enqueues are observable.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock("../src/queue/boss.js", () => ({
  PROCESS_BOOK_QUEUE: "process-book",
  AI_DEFINITION_QUEUE: "ai-definition",
  AI_WORD_DEFINITION_QUEUE: "ai-word-definition",
  PRUNE_USAGE_QUEUE: "prune-usage-events",
  getBoss: () => ({ send: sendSpy }),
  startQueue: vi.fn(),
  stopQueue: vi.fn(),
}));

const { aiWordDefinitions, wordSenses, featureUsageEvents } = schema;
const SLUG = "ai-word-definition-general";

const logger = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

function okResult(meanings: AiDefinitionOutput["meanings"]): ChatJsonResult<AiDefinitionOutput> {
  return {
    data: { meanings },
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.00004,
    model: "google/gemini-3.1-flash-lite",
  };
}

function makeDeps(meanings = [{ pos: "noun", meaning: "a large sea animal" }]) {
  const chat = vi.fn().mockResolvedValue(okResult(meanings));
  const requeue = vi.fn().mockResolvedValue(undefined);
  return {
    chat,
    requeue,
    deps: { chatJson: chat, requeue } as unknown as GeneralAiDefinitionDeps,
  };
}

let userId: string;
const originalKey = env.OPENROUTER_API_KEY;

beforeEach(async () => {
  sendSpy.mockClear();
  userId = await createUser();
  env.OPENROUTER_API_KEY = "test-key";
});
afterEach(() => {
  env.OPENROUTER_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe("requestGeneralAiDefinition", () => {
  it("creates the row once and enqueues a single job", async () => {
    expect(await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: false }))
      .toBe("enqueued");
    expect(sendSpy).toHaveBeenCalledWith("ai-word-definition", {
      language: "en",
      lemma: "whale",
      userId,
    });

    // A second request while it's running must not queue a duplicate.
    expect(await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: false }))
      .toBe("pending");
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("is keyed on the word, not the user — the result is shared", async () => {
    const other = await createUser();
    await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: false });
    expect(await requestGeneralAiDefinition("en", "whale", other, { retryFailed: false }))
      .toBe("pending");
    const rows = await db.select().from(aiWordDefinitions).where(eq(aiWordDefinitions.lemma, "whale"));
    expect(rows).toHaveLength(1);
  });

  it("never regenerates a done definition, and revives a failed one only on retry", async () => {
    await db.insert(aiWordDefinitions).values({ language: "en", lemma: "whale", status: "done" });
    expect(await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: true }))
      .toBe("done");

    await db.update(aiWordDefinitions).set({ status: "failed", error: "boom" });
    expect(await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: false }))
      .toBe("failed");
    expect(await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: true }))
      .toBe("enqueued");
  });

  it("does nothing when no API key is configured", async () => {
    env.OPENROUTER_API_KEY = undefined;
    expect(await requestGeneralAiDefinition("en", "whale", userId, { retryFailed: false }))
      .toBe("disabled");
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("processGeneralAiDefinition", () => {
  beforeEach(async () => {
    await db.insert(aiWordDefinitions).values({ language: "en", lemma: "whale" });
  });

  it("stores the meanings globally — no book, and out of the dictionary's lane", async () => {
    const { deps } = makeDeps();
    await processGeneralAiDefinition({ language: "en", lemma: "whale", userId }, logger, deps);

    const [row] = await db.select().from(aiWordDefinitions).where(eq(aiWordDefinitions.lemma, "whale"));
    expect(row!.status).toBe("done");
    expect(row!.model).toBe("google/gemini-3.1-flash-lite");
    expect(row!.costUsd).toBeCloseTo(0.00004, 6);

    const senses = await db
      .select()
      .from(wordSenses)
      .where(and(eq(wordSenses.lemma, "whale"), isNull(wordSenses.bookId)));
    expect(senses).toHaveLength(1);
    expect(senses[0]!.ai).toBe(true);
    expect(senses[0]!.source).toBe("ai");

    // The dictionary must not serve them; the AI lookup must.
    expect(await getDictionarySenses("en", "whale")).toBeNull();
    expect(await getGlobalAiSenses("en", "whale")).toEqual([
      { pos: "noun", gloss: "a large sea animal" },
    ]);
  });

  it("leaves a real dictionary entry alone", async () => {
    await addDefinition("en", "whale", [{ pos: "noun", gloss: "cetacean" }]);
    const { deps } = makeDeps();
    await processGeneralAiDefinition({ language: "en", lemma: "whale", userId }, logger, deps);
    expect(await getDictionarySenses("en", "whale")).toEqual([{ pos: "noun", gloss: "cetacean" }]);
    expect(await getGlobalAiSenses("en", "whale")).toHaveLength(1);
  });

  it("sends no book context in the prompt", async () => {
    const { chat, deps } = makeDeps();
    await processGeneralAiDefinition({ language: "en", lemma: "whale", userId }, logger, deps);
    const { system, user } = chat.mock.calls[0]![0] as { system: string; user: string };
    expect(user).toContain('Word: "whale"');
    expect(user).not.toMatch(/Book:/);
    expect(system).toContain("most common everyday meaning first");
  });

  it("charges the requester and records the usage", async () => {
    const { deps } = makeDeps();
    await processGeneralAiDefinition({ language: "en", lemma: "whale", userId }, logger, deps);
    const events = await db
      .select()
      .from(featureUsageEvents)
      .where(and(eq(featureUsageEvents.userId, userId), eq(featureUsageEvents.slug, SLUG)));
    expect(events).toHaveLength(1);
  });

  it("defers instead of dropping when the user is over their limit", async () => {
    await addFeatureLimit(SLUG, "minute", 0);
    const { chat, requeue, deps } = makeDeps();
    await processGeneralAiDefinition({ language: "en", lemma: "whale", userId }, logger, deps);
    expect(chat).not.toHaveBeenCalled();
    expect(requeue).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(aiWordDefinitions).where(eq(aiWordDefinitions.lemma, "whale"));
    expect(row!.status).toBe("pending");
  });

  it("refunds the reserved quota when the call fails", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("model exploded"));
    const deps = { chatJson: chat, requeue: vi.fn() } as unknown as GeneralAiDefinitionDeps;
    await processGeneralAiDefinition({ language: "en", lemma: "whale", userId }, logger, deps);

    const [row] = await db.select().from(aiWordDefinitions).where(eq(aiWordDefinitions.lemma, "whale"));
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("model exploded");
    const events = await db
      .select()
      .from(featureUsageEvents)
      .where(and(eq(featureUsageEvents.userId, userId), eq(featureUsageEvents.slug, SLUG)));
    expect(events).toHaveLength(0);
  });
});

describe("POST /api/words/:lemma/ai-definition", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { email: "ai-general@example.com", password: "supersecret123", name: "T" },
    });
    const raw = res.headers["set-cookie"];
    cookie = (Array.isArray(raw) ? raw : [raw])
      .filter((c): c is string => Boolean(c))
      .map((c) => c.split(";")[0])
      .join("; ");
  });

  const post = (word: string) =>
    app.inject({ method: "POST", url: `/api/words/${word}/ai-definition`, headers: { cookie } });

  it("accepts the request and reports it as pending", async () => {
    const res = await post("whale");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ aiDefinition: { status: "pending" } });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("conflicts once one already exists", async () => {
    await db.insert(aiWordDefinitions).values({ language: "en", lemma: "whale", status: "done" });
    expect((await post("whale")).statusCode).toBe(409);
  });

  it("rejects a one-character lemma and an anonymous caller", async () => {
    expect((await post("a")).statusCode).toBe(400);
    const anon = await app.inject({ method: "POST", url: "/api/words/whale/ai-definition" });
    expect(anon.statusCode).toBe(401);
  });

  it("reports the feature as unavailable with no API key", async () => {
    env.OPENROUTER_API_KEY = undefined;
    expect((await post("whale")).statusCode).toBe(503);
  });

  it("works for a word that is in no book at all", async () => {
    // The point of the context-free definition: it describes the word, not a book.
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [{ word: "ship", lemma: "ship", count: 1 }]);
    expect((await post("elsewhere")).statusCode).toBe(202);
  });
});
