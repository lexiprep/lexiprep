import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { schema } from "../src/db/client.js";
import { consume } from "../src/usage/service.js";
import type { PaidFeatureSlug } from "../src/usage/features.js";

/**
 * Proves the unbypassable guarantee under real concurrency. pglite is single-connection
 * and serializes statements, so it CANNOT exercise the advisory lock's race — this test
 * needs real Postgres. It is opt-in: set `TEST_PG_URL` to a disposable database (e.g.
 * the Docker dev DB) to run it; otherwise it's skipped. It touches only its own throwaway
 * slug/user, so it won't disturb seeded policy.
 */
const TEST_PG_URL = process.env.TEST_PG_URL;
const SLUG = "concurrency-test-feature" as PaidFeatureSlug;

describe.skipIf(!TEST_PG_URL)("usage: concurrency (real Postgres)", () => {
  let client: { end: () => Promise<void> };
  let pgDb: PostgresJsDatabase<typeof schema>;
  const userId = `user_${randomUUID()}`;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const sql = postgres(TEST_PG_URL!, { max: 20 });
    client = sql;
    pgDb = drizzle(sql, { schema });

    await pgDb.delete(schema.featureUsageEvents).where(eq(schema.featureUsageEvents.slug, SLUG));
    await pgDb.delete(schema.featureLimits).where(eq(schema.featureLimits.slug, SLUG));
    await pgDb
      .insert(schema.user)
      .values({ id: userId, name: "Concurrency", email: `${userId}@example.com` });
    await pgDb.insert(schema.featureLimits).values({ slug: SLUG, window: "minute", maxCount: 5 });
  });

  afterAll(async () => {
    if (!pgDb) return;
    await pgDb.delete(schema.featureUsageEvents).where(eq(schema.featureUsageEvents.slug, SLUG));
    await pgDb.delete(schema.featureLimits).where(eq(schema.featureLimits.slug, SLUG));
    await pgDb.delete(schema.user).where(eq(schema.user.id, userId));
    await client.end();
  });

  it("admits exactly `max` under 20 concurrent consumes", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consume(userId, SLUG, pgDb)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);

    const rows = await pgDb
      .select({ id: schema.featureUsageEvents.id })
      .from(schema.featureUsageEvents)
      .where(
        and(
          eq(schema.featureUsageEvents.userId, userId),
          eq(schema.featureUsageEvents.slug, SLUG),
        ),
      );
    expect(rows).toHaveLength(5);
  });
});
