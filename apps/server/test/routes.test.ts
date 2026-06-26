import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { addBookWords, createBook } from "./helpers/db.js";

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

/** Sign up through Better Auth and capture the session cookie + user id. */
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
  // resetDb (setup.ts) has already wiped the DB; create a fresh signed-in user.
  alice = await signUp("alice@example.com");
});

describe("auth boundary", () => {
  it("GET /api/me returns the signed-in user", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { id: string } }).user.id).toBe(alice.userId);
  });

  it("rejects a request with no session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/books" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/books", () => {
  it("lists only the caller's own books", async () => {
    await createBook(alice.userId, { title: "Alice's Book" });
    const bob = await signUp("bob@example.com");
    await createBook(bob.userId, { title: "Bob's Book" });

    const res = await app.inject({ method: "GET", url: "/api/books", headers: { cookie: alice.cookie } });
    const titles = (res.json() as { books: { title: string }[] }).books.map((b) => b.title);
    expect(titles).toEqual(["Alice's Book"]);
  });
});

describe("GET /api/books/:id", () => {
  it("404s another user's book (tenant isolation)", async () => {
    const book = await createBook(alice.userId);
    const bob = await signUp("bob@example.com");
    const res = await app.inject({
      method: "GET",
      url: `/api/books/${book.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s a malformed id without erroring", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/books/not-a-uuid",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/books/:id/words", () => {
  it("returns grouped words with stats", async () => {
    const book = await createBook(alice.userId);
    await addBookWords(book.id, [
      { word: "says", lemma: "say", count: 3, level: "A1" },
      { word: "said", lemma: "say", count: 5, level: "A1" },
      { word: "the", lemma: null, count: 9, isStopword: true },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/books/${book.id}/words`,
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      stats: { total: number; remaining: number };
      words: { word: string; count: number }[];
    };
    expect(body.stats.total).toBe(1); // one non-stopword lemma ("say")
    expect(body.words).toEqual([{ word: "say", count: 8, level: "A1", example: null, status: null }]);
  });
});

describe("POST /api/books/:id/review", () => {
  it("resolves a batch and the words drop out of the to-review list", async () => {
    const book = await createBook(alice.userId);
    await addBookWords(book.id, [
      { word: "alpha", lemma: "alpha", count: 3, level: "B1" },
      { word: "beta", lemma: "beta", count: 2, level: "B1" },
    ]);

    const review = await app.inject({
      method: "POST",
      url: `/api/books/${book.id}/review`,
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { words: ["alpha", "beta"], learning: ["alpha"] },
    });
    expect(review.json()).toEqual({ learning: 1, resolved: 1 });

    const after = await app.inject({
      method: "GET",
      url: `/api/books/${book.id}/words`,
      headers: { cookie: alice.cookie },
    });
    expect((after.json() as { words: unknown[] }).words).toHaveLength(0);
  });

  it("finishes the whole book", async () => {
    const book = await createBook(alice.userId);
    await addBookWords(book.id, [{ word: "gamma", lemma: "gamma", count: 1, level: "C1" }]);
    const res = await app.inject({
      method: "POST",
      url: `/api/books/${book.id}/review`,
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { finish: true },
    });
    expect(res.json()).toEqual({ known: 1 });
  });
});

describe("/api/words vocabulary management", () => {
  it("adds, lists and removes a word", async () => {
    const add = await app.inject({
      method: "POST",
      url: "/api/words",
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { items: [{ lemma: "wanderlust", status: "learning" }] },
    });
    expect(add.json()).toEqual({ ok: true, count: 1 });

    const list = await app.inject({
      method: "GET",
      url: "/api/words?status=learning",
      headers: { cookie: alice.cookie },
    });
    expect((list.json() as { words: { lemma: string }[] }).words.map((w) => w.lemma)).toEqual([
      "wanderlust",
    ]);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/words/wanderlust",
      headers: { cookie: alice.cookie },
    });
    expect(del.json()).toEqual({ ok: true });

    const after = await app.inject({
      method: "GET",
      url: "/api/words?status=learning",
      headers: { cookie: alice.cookie },
    });
    expect((after.json() as { words: unknown[] }).words).toHaveLength(0);
  });

  it("rejects an invalid status with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/words",
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { items: [{ lemma: "x", status: "bogus" }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/words/review", () => {
  it("returns the cross-book learning list with stats", async () => {
    const book = await createBook(alice.userId, { title: "Lib" });
    await addBookWords(book.id, [{ word: "ocean", lemma: "ocean", count: 4, level: "B1" }]);
    await app.inject({
      method: "POST",
      url: "/api/words",
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { items: [{ lemma: "ocean", status: "learning" }] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/words/review",
      headers: { cookie: alice.cookie },
    });
    const body = res.json() as { words: { word: string; count: number }[]; stats: { total: number } };
    expect(body.stats.total).toBe(1);
    expect(body.words[0]).toMatchObject({ word: "ocean", count: 4 });
  });
});

describe("GET /api/words/export", () => {
  it("returns an Anki-importable TSV deck", async () => {
    const book = await createBook(alice.userId);
    await addBookWords(book.id, [
      { word: "ocean", lemma: "ocean", count: 4, level: "B1", example: "the sea" },
    ]);
    await app.inject({
      method: "POST",
      url: "/api/words",
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { items: [{ lemma: "ocean", status: "learning" }] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/words/export",
      headers: { cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/tab-separated-values");
    expect(res.body).toContain("#separator:tab");
    expect(res.body).toContain("ocean");
  });
});

describe("POST /api/books (upload guardrails)", () => {
  it("415s an unsupported file type (e.g. .txt)", async () => {
    const boundary = "----lexipreptestboundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="notes.txt"',
      "Content-Type: text/plain",
      "",
      "not an ebook",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const res = await app.inject({
      method: "POST",
      url: "/api/books",
      headers: {
        cookie: alice.cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(415);
  });
});
