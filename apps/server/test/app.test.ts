import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("server skeleton", () => {
  it("GET /health is ok without any dependencies", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/demo proves @lexiprep/core is wired in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/demo" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { top: { word: string; count: number }[] };
    // "fox" appears 3x and stopwords are filtered out
    expect(body.top[0]).toEqual({ word: "fox", count: 3 });
  });

  it("protected /api/me returns 401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("book routes require auth (401)", async () => {
    const list = await app.inject({ method: "GET", url: "/api/books" });
    expect(list.statusCode).toBe(401);
    const upload = await app.inject({ method: "POST", url: "/api/books" });
    expect(upload.statusCode).toBe(401);
  });

  it("vocabulary routes require auth (401)", async () => {
    const list = await app.inject({ method: "GET", url: "/api/words" });
    expect(list.statusCode).toBe(401);
    const add = await app.inject({ method: "POST", url: "/api/words" });
    expect(add.statusCode).toBe(401);
    const learning = await app.inject({ method: "GET", url: "/api/words/review" });
    expect(learning.statusCode).toBe(401);
    const review = await app.inject({ method: "POST", url: "/api/books/x/review" });
    expect(review.statusCode).toBe(401);
  });
});
