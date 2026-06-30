import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { addBookWords, createBook, setUserWord } from "./helpers/db.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
});

interface Account {
  cookie: string;
  userId: string;
}

async function signUp(email: string): Promise<Account> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    payload: { email, password: "supersecret123", name: "Test" },
  });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw])
    .filter((c): c is string => Boolean(c))
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).not.toBe("");
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  return { cookie, userId: (me.json() as { user: { id: string } }).user.id };
}

let alice: Account;

beforeEach(async () => {
  alice = await signUp("alice@example.com");
});

function postJson(url: string, cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { cookie, "content-type": "application/json" },
    payload: body,
  });
}
function putJson(url: string, cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PUT",
    url,
    headers: { cookie, "content-type": "application/json" },
    payload: body,
  });
}

describe("GET /api/review/session", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/review/session" });
    expect(res.statusCode).toBe(401);
  });

  it("assembles new cards with counts and the day streak", async () => {
    const book = await createBook(alice.userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "apple", lemma: "apple", count: 10, level: "A1", example: "an apple a day" },
    ]);
    await setUserWord(alice.userId, "en", "apple", "learning");

    const res = await app.inject({
      method: "GET",
      url: "/api/review/session",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cards: { lemma: string; word: string; level: string; example: string; isNew: boolean; preview: { easy: string } }[];
      counts: { new: number; due: number; remaining: number; totalDue: number };
      streak: number;
    };
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({
      lemma: "apple",
      word: "apple",
      level: "A1",
      example: "an apple a day",
      isNew: true,
    });
    expect(body.cards[0]!.preview).toMatchObject({ again: "1m", hard: "1m", good: "10m" });
    expect(body.cards[0]!.preview.easy).toMatch(/^[345]d$/);
    expect(body.counts).toMatchObject({ new: 1, due: 0, remaining: 1, totalDue: 0 });
    expect(body.streak).toBe(0);
  });

  it("400s a malformed bookId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/review/session?bookId=not-a-uuid",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/review/grade", () => {
  beforeEach(async () => {
    const book = await createBook(alice.userId, { language: "en" });
    await addBookWords(book.id, [{ word: "apple", lemma: "apple", count: 10, level: "A1" }]);
    await setUserWord(alice.userId, "en", "apple", "learning");
  });

  it("grades a card and returns the re-show info", async () => {
    const res = await postJson("/api/review/grade", alice.cookie, { lemma: "apple", grade: 3 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stays: boolean;
      graduated: boolean;
      card: { state: string; intervalDays: number; due: string | null; preview: unknown };
    };
    expect(body.stays).toBe(true);
    expect(body.graduated).toBe(false);
    expect(body.card.state).toBe("learning");
    expect(body.card.preview).toBeTruthy();
  });

  it("404s an unknown word", async () => {
    const res = await postJson("/api/review/grade", alice.cookie, { lemma: "ghost", grade: 3 });
    expect(res.statusCode).toBe(404);
  });

  it("400s an out-of-range grade", async () => {
    const res = await postJson("/api/review/grade", alice.cookie, { lemma: "apple", grade: 9 });
    expect(res.statusCode).toBe(400);
  });

  it("400s a missing lemma", async () => {
    const res = await postJson("/api/review/grade", alice.cookie, { grade: 3 });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/review/stats", () => {
  it("returns the stat shape and reflects a graded card", async () => {
    const book = await createBook(alice.userId, { language: "en" });
    await addBookWords(book.id, [{ word: "apple", lemma: "apple", count: 10, level: "A1" }]);
    await setUserWord(alice.userId, "en", "apple", "learning");
    await postJson("/api/review/grade", alice.cookie, { lemma: "apple", grade: 3 });

    const res = await app.inject({
      method: "GET",
      url: "/api/review/stats",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      dayStreak: 1,
      reviewedToday: 1,
      reviewedAllTime: 1,
      avgDaysBetween: null,
    });
  });
});

describe("GET /api/review/stats/timeseries", () => {
  it("returns buckets after a grade", async () => {
    const book = await createBook(alice.userId, { language: "en" });
    await addBookWords(book.id, [{ word: "apple", lemma: "apple", count: 10, level: "A1" }]);
    await setUserWord(alice.userId, "en", "apple", "learning");
    await postJson("/api/review/grade", alice.cookie, { lemma: "apple", grade: 3 });

    const res = await app.inject({
      method: "GET",
      url: "/api/review/stats/timeseries?granularity=day",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      granularity: string;
      buckets: { period: string; reviews: number; good: number }[];
    };
    expect(body.granularity).toBe("day");
    expect(body.buckets.reduce((sum, b) => sum + b.reviews, 0)).toBe(1);
    expect(body.buckets.reduce((sum, b) => sum + b.good, 0)).toBe(1);
  });
});

describe("settings routes", () => {
  it("GET returns the defaults", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      newPerDay: 20,
      maxPerDay: 200,
      autoGraduateKnown: false,
      timezone: null,
    });
  });

  it("PUT round-trips a partial patch", async () => {
    const res = await putJson("/api/settings", alice.cookie, {
      newPerDay: 7,
      autoGraduateKnown: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ newPerDay: 7, maxPerDay: 200, autoGraduateKnown: true });

    const get = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: alice.cookie },
    });
    expect(get.json()).toMatchObject({ newPerDay: 7, autoGraduateKnown: true });
  });

  it("PUT 400s an invalid timezone", async () => {
    const res = await putJson("/api/settings", alice.cookie, { timezone: "Nowhere/Land" });
    expect(res.statusCode).toBe(400);
  });
});
