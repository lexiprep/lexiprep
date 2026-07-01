import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { addFeatureLimit } from "./helpers/db.js";

let app: FastifyInstance;

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
beforeEach(async () => {
  cookie = await signUp("alice@example.com");
});

describe("GET /api/usage/features", () => {
  it("lists the paid-feature catalogue", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage/features", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { features } = res.json() as { features: { slug: string }[] };
    expect(features.map((f) => f.slug)).toContain("ai-word-definition-from-context");
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage/features" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/usage/check", () => {
  it("returns allowed:true when under the limit", async () => {
    await addFeatureLimit("ai-word-definition-from-context", "minute", 5);
    const res = await app.inject({
      method: "POST",
      url: "/api/usage/check",
      headers: { cookie, "content-type": "application/json" },
      payload: { slug: "ai-word-definition-from-context" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { allowed: boolean }).allowed).toBe(true);
  });

  it("400s an unknown slug", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/usage/check",
      headers: { cookie, "content-type": "application/json" },
      payload: { slug: "nope" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/usage/demo (guarded)", () => {
  it("serves until the limit, then 429s with Retry-After — unbypassable", async () => {
    await addFeatureLimit("ai-word-definition-from-context", "minute", 2);

    const call = () =>
      app.inject({ method: "POST", url: "/api/usage/demo", headers: { cookie } });

    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);

    const blocked = await call();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    const body = blocked.json() as { error: string; slug: string; retryAfter: number };
    expect(body.slug).toBe("ai-word-definition-from-context");
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});
