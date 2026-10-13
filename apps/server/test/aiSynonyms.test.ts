import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { db, schema } from "../src/db/client.js";
import { env } from "../src/env.js";
import { requestAiSynonyms } from "../src/ai/synonymService.js";
import {
  cleanSynonyms,
  keepNoHarder,
  type AiSynonymsOutput,
} from "../src/ai/synonymPrompt.js";
import { processAiSynonyms, type AiSynonymsDeps } from "../src/queue/processAiSynonyms.js";
import { getWordDetail } from "../src/books/service.js";
import type { ChatJsonResult } from "../src/ai/openrouter.js";
import {
  addBookWords,
  addFeatureLimit,
  addWordLevel,
  createBook,
  createUser,
} from "./helpers/db.js";

// The queue isn't started in tests; stub the boss so enqueues are observable.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock("../src/queue/boss.js", () => ({
  PROCESS_BOOK_QUEUE: "process-book",
  AI_DEFINITION_QUEUE: "ai-definition",
  AI_WORD_DEFINITION_QUEUE: "ai-word-definition",
  AI_SYNONYMS_QUEUE: "ai-word-synonyms",
  PRUNE_USAGE_QUEUE: "prune-usage-events",
  getBoss: () => ({ send: sendSpy }),
  startQueue: vi.fn(),
  stopQueue: vi.fn(),
}));

const { aiWordSynonyms, featureUsageEvents } = schema;
const SLUG = "ai-word-synonyms";

const logger = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

function okResult(synonyms: string[]): ChatJsonResult<AiSynonymsOutput> {
  return {
    data: { synonyms },
    inputTokens: 90,
    outputTokens: 20,
    costUsd: 0.00003,
    model: "google/gemini-3.1-flash-lite",
  };
}

function makeDeps(synonyms = ["glad", "cheerful", "content"]) {
  const chat = vi.fn().mockResolvedValue(okResult(synonyms));
  const requeue = vi.fn().mockResolvedValue(undefined);
  return { chat, requeue, deps: { chatJson: chat, requeue } as unknown as AiSynonymsDeps };
}

async function synonymsRow(lemma = "happy") {
  const [row] = await db
    .select()
    .from(aiWordSynonyms)
    .where(and(eq(aiWordSynonyms.language, "en"), eq(aiWordSynonyms.lemma, lemma)));
  return row;
}

const usageCount = async () =>
  (await db.select().from(featureUsageEvents).where(eq(featureUsageEvents.slug, SLUG))).length;

let userId: string;
const originalKey = env.OPENROUTER_API_KEY;

beforeEach(async () => {
  sendSpy.mockClear();
  userId = await createUser();
  env.OPENROUTER_API_KEY = "test-key";
});
afterEach(() => {
  env.OPENROUTER_API_KEY = originalKey;
});

describe("cleanSynonyms", () => {
  it("keeps the model's order, drops blanks, repeats and the word itself, and caps at five", () => {
    expect(
      cleanSynonyms("happy", [" glad ", "", "Happy", "cheerful", "GLAD", "content", "joyful", "merry", "jolly"]),
    ).toEqual(["glad", "cheerful", "content", "joyful", "merry"]);
  });

  it("drops a phrase that contains the word itself", () => {
    expect(cleanSynonyms("lie", ["tell a lie", "untruth", "white-lie", "fib"])).toEqual([
      "untruth",
      "fib",
    ]);
  });
});

describe("keepNoHarder", () => {
  const levels = new Map([
    ["seer", "B1"],
    ["oracle", "C1"],
    ["demise", "C1"],
    ["passing", "A2"],
  ]);

  it("drops a one-word synonym above the word's level or missing from the list", () => {
    expect(keepNoHarder("C1", ["seer", "oracle", "soothsayer", "diviner"], levels)).toEqual([
      "seer",
      "oracle",
    ]);
    expect(keepNoHarder("A2", ["end of life", "demise", "passing", "decease"], levels)).toEqual([
      "end of life",
      "passing",
    ]);
  });

  it("always lets basic A1-A2 words through, even for an A1 word", () => {
    expect(keepNoHarder("A1", ["passing", "seer"], levels)).toEqual(["passing"]);
  });

  it("keeps phrases and hyphenated words, which the list never has", () => {
    expect(keepNoHarder("C1", ["well-built", "end of life"], levels)).toEqual([
      "well-built",
      "end of life",
    ]);
  });

  it("keeps everything when the word itself has no level", () => {
    expect(keepNoHarder(null, ["soothsayer", "demise"], levels)).toEqual(["soothsayer", "demise"]);
  });
});

describe("requestAiSynonyms", () => {
  it("creates one shared row per word and enqueues a single job", async () => {
    const other = await createUser();
    expect(await requestAiSynonyms("en", "Happy", userId, null, { retryFailed: false })).toBe(
      "enqueued",
    );
    expect(sendSpy).toHaveBeenCalledWith("ai-word-synonyms", {
      language: "en",
      lemma: "happy",
      userId,
      bookId: null,
    });
    expect(await requestAiSynonyms("en", "happy", other, null, { retryFailed: false })).toBe(
      "pending",
    );
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("never regenerates done synonyms, and revives failed ones only on retry", async () => {
    await db.insert(aiWordSynonyms).values({ language: "en", lemma: "happy", status: "done" });
    expect(await requestAiSynonyms("en", "happy", userId, null, { retryFailed: true })).toBe("done");

    await db.update(aiWordSynonyms).set({ status: "failed", error: "boom" });
    expect(await requestAiSynonyms("en", "happy", userId, null, { retryFailed: false })).toBe(
      "failed",
    );
    expect(await requestAiSynonyms("en", "happy", userId, null, { retryFailed: true })).toBe(
      "enqueued",
    );
  });

  it("removes its row when the queue is down, so a later request starts clean", async () => {
    sendSpy.mockRejectedValueOnce(new Error("queue down"));
    await expect(
      requestAiSynonyms("en", "happy", userId, null, { retryFailed: false }),
    ).rejects.toThrow("queue down");
    expect(await synonymsRow()).toBeUndefined();
  });

  it("does nothing when no API key is configured", async () => {
    env.OPENROUTER_API_KEY = undefined;
    expect(await requestAiSynonyms("en", "happy", userId, null, { retryFailed: false })).toBe(
      "disabled",
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("processAiSynonyms", () => {
  beforeEach(async () => {
    await db.insert(aiWordSynonyms).values({ language: "en", lemma: "happy" });
  });

  it("stores the cleaned list with model, tokens and cost, and charges the requester", async () => {
    const { deps } = makeDeps(["glad", "cheerful", "happy", "content"]);
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);

    const row = await synonymsRow();
    expect(row).toMatchObject({
      status: "done",
      synonyms: ["glad", "cheerful", "content"],
      error: null,
      model: "google/gemini-3.1-flash-lite",
      inputTokens: 90,
      outputTokens: 20,
    });
    expect(await usageCount()).toBe(1);
  });

  it("accepts an empty list: a word with no close synonym is done, not failed", async () => {
    const { deps } = makeDeps([]);
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);
    expect(await synonymsRow()).toMatchObject({ status: "done", synonyms: [] });
  });

  it("names no count in the prompt, and asks for fewer rather than loose synonyms", async () => {
    const { chat, deps } = makeDeps();
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);
    const { system, user } = chat.mock.calls[0]![0] as { system: string; user: string };
    expect(system).toContain("Fewer is better than loose");
    expect(system).not.toMatch(/\d/);
    expect(user).toContain('Word: "happy"');
    expect(user).not.toContain("<context_examples>");
  });

  it("asks for synonyms no harder than the word, and drops the harder ones it still gets", async () => {
    await addWordLevel("en", "happy", "A1");
    await addWordLevel("en", "glad", "A1");
    await addWordLevel("en", "delighted", "B1");
    await addWordLevel("en", "pleased", "A2");
    const { chat, deps } = makeDeps(["glad", "delighted", "pleased", "jubilant", "pleased with oneself"]);
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);

    const { system, user } = chat.mock.calls[0]![0] as { system: string; user: string };
    expect(system).toContain("none may be harder than it");
    expect(user).toContain("CEFR level of the word: A1");
    expect((await synonymsRow())!.synonyms).toEqual(["glad", "pleased", "pleased with oneself"]);
  });

  it("lends the requester's book sentences to the prompt", async () => {
    const book = await createBook(userId);
    await addBookWords(book.id, [
      { word: "happy", lemma: "happy", count: 2, example: "She was happy to see the sea." },
    ]);
    const { chat, deps } = makeDeps();
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: book.id }, logger, deps);
    const { user } = chat.mock.calls[0]![0] as { user: string };
    expect(user).toContain("<context_examples>");
    expect(user).toContain("She was happy to see the sea.");
  });

  it("never reads another user's book", async () => {
    const stranger = await createUser();
    const book = await createBook(stranger);
    await addBookWords(book.id, [
      { word: "happy", lemma: "happy", count: 2, example: "A private sentence." },
    ]);
    const { chat, deps } = makeDeps();
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: book.id }, logger, deps);
    const { user } = chat.mock.calls[0]![0] as { user: string };
    expect(user).not.toContain("A private sentence.");
  });

  it("defers instead of dropping when the user is over their limit", async () => {
    await addFeatureLimit(SLUG, "minute", 0);
    const { chat, requeue, deps } = makeDeps();
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);
    expect(chat).not.toHaveBeenCalled();
    expect(requeue.mock.calls[0]![0]).toEqual({
      language: "en",
      lemma: "happy",
      userId,
      bookId: null,
      deferrals: 1,
    });
    expect((await synonymsRow())!.status).toBe("pending");
  });

  it("fails and refunds when the call throws or the answer is malformed", async () => {
    const { chat, deps } = makeDeps();
    chat.mockRejectedValueOnce(new Error("model exploded"));
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);
    expect(await synonymsRow()).toMatchObject({ status: "failed", error: "model exploded" });

    await db.update(aiWordSynonyms).set({ status: "pending", error: null });
    chat.mockResolvedValueOnce({ ...okResult([]), data: { words: ["glad"] } } as never);
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);
    expect((await synonymsRow())!.status).toBe("failed");
    expect(await usageCount()).toBe(0);
  });

  it("is a no-op for done synonyms", async () => {
    await db.update(aiWordSynonyms).set({ status: "done", synonyms: ["glad"] });
    const { chat, deps } = makeDeps();
    await processAiSynonyms({ language: "en", lemma: "happy", userId, bookId: null }, logger, deps);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("word detail", () => {
  it("carries the synonyms' state, and the list only once done", async () => {
    const book = await createBook(userId);
    await addBookWords(book.id, [{ word: "happy", lemma: "happy", count: 1 }]);

    expect((await getWordDetail(userId, book, "happy"))!.aiSynonyms).toBeNull();

    await db.insert(aiWordSynonyms).values({ language: "en", lemma: "happy" });
    expect((await getWordDetail(userId, book, "happy"))!.aiSynonyms).toEqual({
      status: "pending",
      synonyms: null,
      error: null,
    });

    await db.update(aiWordSynonyms).set({ status: "done", synonyms: ["glad", "cheerful"] });
    expect((await getWordDetail(userId, book, "happy"))!.aiSynonyms).toEqual({
      status: "done",
      synonyms: ["glad", "cheerful"],
      error: null,
    });
  });
});

describe("POST /api/words/:lemma/ai-synonyms", () => {
  let app: FastifyInstance;
  let cookie: string;
  let ownerId: string;

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
      payload: { email: "ai-synonyms@example.com", password: "supersecret123", name: "T" },
    });
    ownerId = res.json().user.id;
    const raw = res.headers["set-cookie"];
    cookie = (Array.isArray(raw) ? raw : [raw])
      .filter((c): c is string => Boolean(c))
      .map((c) => c.split(";")[0])
      .join("; ");
  });

  const post = (word: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/words/${word}/ai-synonyms`,
      headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload } : {}),
    });

  it("accepts the request and reports it as pending", async () => {
    const res = await post("happy");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ aiSynonyms: { status: "pending" } });
    expect(sendSpy).toHaveBeenCalledWith("ai-word-synonyms", {
      language: "en",
      lemma: "happy",
      userId: ownerId,
      bookId: null,
    });
  });

  it("passes the caller's own book on, and refuses someone else's", async () => {
    const mine = await createBook(ownerId);
    expect((await post("happy", { bookId: mine.id })).statusCode).toBe(202);
    expect(sendSpy.mock.calls[0]![1]).toMatchObject({ bookId: mine.id });

    const theirs = await createBook(userId);
    expect((await post("glad", { bookId: theirs.id })).statusCode).toBe(404);
    expect((await post("glad", { bookId: "not-a-uuid" })).statusCode).toBe(404);
  });

  it("conflicts once the synonyms exist", async () => {
    await db.insert(aiWordSynonyms).values({ language: "en", lemma: "happy", status: "done" });
    expect((await post("happy")).statusCode).toBe(409);
  });

  it("answers 429 up front when the user is over the limit", async () => {
    await addFeatureLimit(SLUG, "minute", 0);
    const res = await post("happy");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ slug: SLUG });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects a one-character lemma, an anonymous caller, and a missing API key", async () => {
    expect((await post("a")).statusCode).toBe(400);
    const anon = await app.inject({ method: "POST", url: "/api/words/happy/ai-synonyms" });
    expect(anon.statusCode).toBe(401);
    env.OPENROUTER_API_KEY = undefined;
    expect((await post("happy")).statusCode).toBe(503);
  });
});
