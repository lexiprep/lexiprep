import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { db, schema } from "../src/db/client.js";
import { consume, peek, refund } from "../src/usage/service.js";
import { FEATURE_META, PAID_FEATURES, type PaidFeatureSlug } from "../src/usage/features.js";
import { addFeatureLimit, createUser } from "./helpers/db.js";

const { featureUsageEvents } = schema;
const SLUG = "ai-word-definition-from-context";

async function rowCount(userId: string, slug: string): Promise<number> {
  const rows = await db
    .select({ id: featureUsageEvents.id })
    .from(featureUsageEvents)
    .where(and(eq(featureUsageEvents.userId, userId), eq(featureUsageEvents.slug, slug)));
  return rows.length;
}

describe("usage: consume enforces the limit", () => {
  it("allows exactly `max` uses then rejects, and rejects don't record", async () => {
    const user = await createUser();
    await addFeatureLimit(SLUG, "minute", 5);

    const results = [];
    for (let i = 0; i < 6; i++) results.push(await consume(user, SLUG));

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results[5]!.allowed).toBe(false);
    expect(await rowCount(user, SLUG)).toBe(5); // the rejected 6th inserted nothing
  });

  it("peek reports the exhausted state without consuming", async () => {
    const user = await createUser();
    await addFeatureLimit(SLUG, "minute", 5);
    for (let i = 0; i < 5; i++) await consume(user, SLUG);

    const p = await peek(user, SLUG);
    expect(p.allowed).toBe(false);
    expect(p.windows[0]!.remaining).toBe(0);
    expect(await rowCount(user, SLUG)).toBe(5); // peek added nothing
  });

  it("the tightest of several windows governs", async () => {
    const user = await createUser();
    await addFeatureLimit(SLUG, "minute", 5);
    await addFeatureLimit(SLUG, "hour", 3);

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await consume(user, SLUG));
    expect(results.filter((r) => r.allowed)).toHaveLength(3); // hour=3 wins
  });

  it("an unconfigured feature is unlimited but still logged (fail-open)", async () => {
    const user = await createUser();
    const slug = "some-unconfigured-feature" as PaidFeatureSlug;

    const r = await consume(user, slug);
    expect(r.allowed).toBe(true);
    expect(r.windows).toHaveLength(0);
    expect(await rowCount(user, slug)).toBe(1); // ledger records it
  });

  it("limits are per-user (one user hitting the cap doesn't block another)", async () => {
    const alice = await createUser();
    const bob = await createUser();
    await addFeatureLimit(SLUG, "minute", 2);

    await consume(alice, SLUG);
    await consume(alice, SLUG);
    expect((await consume(alice, SLUG)).allowed).toBe(false);
    expect((await consume(bob, SLUG)).allowed).toBe(true); // bob unaffected
  });

  it("refund frees a consumed slot", async () => {
    const user = await createUser();
    await addFeatureLimit(SLUG, "minute", 1);

    const first = await consume(user, SLUG);
    expect(first.allowed).toBe(true);
    expect((await consume(user, SLUG)).allowed).toBe(false);

    await refund(first.eventId!);
    expect((await consume(user, SLUG)).allowed).toBe(true);
  });
});

describe("usage: registry", () => {
  it("every enforced feature is seeded with limits by a migration", () => {
    // The policy lives in the drizzle data-migrations (not run against pglite), so we
    // assert the seed SQL configures every feature marked enforced — the backstop that
    // keeps fail-open from silently shipping an ungated paid feature.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");

    for (const slug of PAID_FEATURES) {
      if (!FEATURE_META[slug].enforced) continue;
      expect(sql).toContain("feature_limits");
      expect(sql).toContain(`'${slug}'`);
    }
  });
});
