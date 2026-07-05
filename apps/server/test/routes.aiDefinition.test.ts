import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { db, schema } from "../src/db/client.js";
import { env } from "../src/env.js";
import {
  addAiDefinition,
  addBookWords,
  addFeatureLimit,
  createBook,
  createUser,
} from "./helpers/db.js";

// The queue is not started in route tests; stub the boss so enqueues are observable.
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock("../src/queue/boss.js", () => ({
  PROCESS_BOOK_QUEUE: "process-book",
  AI_DEFINITION_QUEUE: "ai-definition",
  PRUNE_USAGE_QUEUE: "prune-usage-events",
  getBoss: () => ({ send: sendSpy }),
  startQueue: vi.fn(),
  stopQueue: vi.fn(),
}));

const { aiDefinitions } = schema;

let app: FastifyInstance;
const originalKey = env.OPENROUTER_API_KEY;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
});

async function signUp(email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    payload: { email, password: "supersecret123", name: "Test" },
  });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : [raw])
    .filter((c): c is string => Boolean(c))
    .map((c) => c.split(";")[0])
    .join("; ");
}

let cookie: string;
let userId: string;
let bookId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  sendSpy.mockResolvedValue("job-id");
  env.OPENROUTER_API_KEY = "test-key";
  cookie = await signUp("alice@example.com");
  const [u] = await db.select({ id: schema.user.id }).from(schema.user);
  userId = u!.id;
  const book = await createBook(userId, { title: "A Book" });
  bookId = book.id;
  await addBookWords(bookId, [
    { word: "whale", lemma: "whale", count: 3, example: "The whale surfaced." },
    { word: "whales", lemma: "whale", count: 2 },
  ]);
  await addFeatureLimit("ai-word-definition-from-context", "minute", 10);
});

afterEach(() => {
  env.OPENROUTER_API_KEY = originalKey;
});

const aiRows = () =>
  db
    .select()
    .from(aiDefinitions)
    .where(and(eq(aiDefinitions.bookId, bookId), eq(aiDefinitions.lemma, "whale")));

const post = (path: string, payload?: Record<string, unknown>) => {
  // Fastify 400s an empty body when content-type is application/json.
  const opts: InjectOptions = {
    method: "POST",
    url: path,
    headers: payload !== undefined ? { cookie, "content-type": "application/json" } : { cookie },
  };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
};

describe("POST /api/books/:id/words/:word/ai-definition (manual trigger)", () => {
  it("creates a pending row and enqueues exactly one job (202)", async () => {
    const res = await post(`/api/books/${bookId}/words/whale/ai-definition`);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ aiDefinition: { status: "pending" } });

    const rows = await aiRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("ai-definition", { bookId, lemma: "whale" });
  });

  it("is idempotent while pending: second POST re-enqueues nothing", async () => {
    await post(`/api/books/${bookId}/words/whale/ai-definition`);
    sendSpy.mockClear();

    const res = await post(`/api/books/${bookId}/words/whale/ai-definition`);
    expect(res.statusCode).toBe(202);
    expect(await aiRows()).toHaveLength(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("409s once the definition is done — never regenerate", async () => {
    await addAiDefinition(bookId, "whale", "done");
    const res = await post(`/api/books/${bookId}/words/whale/ai-definition`);
    expect(res.statusCode).toBe(409);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("revives a failed row (retry) and enqueues again", async () => {
    await addAiDefinition(bookId, "whale", "failed", { error: "boom" });
    const res = await post(`/api/books/${bookId}/words/whale/ai-definition`);
    expect(res.statusCode).toBe(202);
    const rows = await aiRows();
    expect(rows[0]).toMatchObject({ status: "pending", error: null });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("404s for a foreign book and for a word not in the book", async () => {
    const other = await createUser();
    const foreign = await createBook(other);
    expect(
      (await post(`/api/books/${foreign.id}/words/whale/ai-definition`)).statusCode,
    ).toBe(404);
    expect((await post(`/api/books/${bookId}/words/nope/ai-definition`)).statusCode).toBe(404);
  });

  it("503s when OpenRouter is not configured", async () => {
    env.OPENROUTER_API_KEY = "";
    const res = await post(`/api/books/${bookId}/words/whale/ai-definition`);
    expect(res.statusCode).toBe(503);
    expect(await aiRows()).toHaveLength(0);
  });

  it("429s with Retry-After when the usage limit is exhausted", async () => {
    await db
      .delete(schema.featureLimits)
      .where(eq(schema.featureLimits.slug, "ai-word-definition-from-context"));
    await addFeatureLimit("ai-word-definition-from-context", "minute", 1);
    await db
      .insert(schema.featureUsageEvents)
      .values({ userId, slug: "ai-word-definition-from-context" });

    const res = await post(`/api/books/${bookId}/words/whale/ai-definition`);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    const body = res.json() as { slug: string; retryAfter: number };
    expect(body.slug).toBe("ai-word-definition-from-context");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(await aiRows()).toHaveLength(0);
  });
});

describe("auto-trigger on words entering `learning`", () => {
  it("POST /api/words with bookId enqueues for new learning words only", async () => {
    const res = await post("/api/words", {
      language: "en",
      bookId,
      items: [
        { lemma: "whale", status: "learning" },
        { lemma: "other", status: "known" },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await aiRows()).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith("ai-definition", { bookId, lemma: "whale" });
  });

  it("re-marking an already-learning word does not re-enqueue", async () => {
    await post("/api/words", {
      language: "en",
      bookId,
      items: [{ lemma: "whale", status: "learning" }],
    });
    sendSpy.mockClear();

    const res = await post("/api/words", {
      language: "en",
      bookId,
      items: [{ lemma: "whale", status: "learning" }],
    });
    expect(res.statusCode).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("without bookId (no book context) nothing is enqueued", async () => {
    const res = await post("/api/words", {
      language: "en",
      items: [{ lemma: "whale", status: "learning" }],
    });
    expect(res.statusCode).toBe(200);
    expect(await aiRows()).toHaveLength(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("a foreign bookId is ignored (status write still succeeds)", async () => {
    const other = await createUser();
    const foreign = await createBook(other);
    const res = await post("/api/words", {
      language: "en",
      bookId: foreign.id,
      items: [{ lemma: "whale", status: "learning" }],
    });
    expect(res.statusCode).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("a review batch enqueues for its flagged (learning) words", async () => {
    const res = await post(`/api/books/${bookId}/review`, {
      words: ["whale", "other"],
      learning: ["whale"],
    });
    expect(res.statusCode, res.body).toBe(200);
    // The HTTP response keeps its public shape (no transitions leak).
    expect(res.json()).toEqual({ learning: 1, resolved: 1 });
    expect(await aiRows()).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledWith("ai-definition", { bookId, lemma: "whale" });
  });

  it("auto-trigger no-ops when OpenRouter is not configured", async () => {
    env.OPENROUTER_API_KEY = "";
    const res = await post("/api/words", {
      language: "en",
      bookId,
      items: [{ lemma: "whale", status: "learning" }],
    });
    expect(res.statusCode).toBe(200);
    expect(await aiRows()).toHaveLength(0);
  });
});
