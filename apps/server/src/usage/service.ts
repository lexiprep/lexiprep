import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { featureLimits, featureUsageEvents, type UsageWindow } from "../db/schema.js";
import type { PaidFeatureSlug } from "./features.js";

/**
 * Metering service (spec 13). Enforces per-user usage limits with an append-only
 * event log + sliding windows. The one part that must be exactly right is
 * {@link consume}: it is race-free because every concurrent call for the same
 * (user, slug) is serialized behind a transaction-scoped Postgres advisory lock,
 * so the count-then-insert can never interleave and the limit is unbypassable.
 */

/**
 * Hardcoded, injection-safe interval literals keyed by the closed {@link UsageWindow}
 * enum. Interpolated into SQL via `sql.raw`, so nothing here may ever come from a
 * request — the enum + this map guarantee only these four literals reach the query.
 */
const WINDOW_SQL_INTERVAL: Record<UsageWindow, string> = {
  minute: "1 minute",
  hour: "1 hour",
  day: "1 day",
  month: "1 month",
};

/** Approximate JS duration per window, for the *display-only* `resetAt`. */
const WINDOW_MS: Record<UsageWindow, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  month: 30 * 86_400_000, // calendar-correct enforcement uses SQL `interval '1 month'`
};

export interface WindowUsage {
  window: UsageWindow;
  used: number;
  max: number;
  remaining: number;
  /** When this window next admits again (oldest counted event + window). Null if empty. */
  resetAt: string | null;
}

export interface UsageResult {
  allowed: boolean;
  windows: WindowUsage[];
  /** Id of the recorded event when a use was consumed — for reserve+refund. */
  eventId?: string;
}

type Exec = typeof db | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Load the configured windows for a slug (empty = unlimited / fail-open). */
async function loadLimits(slug: string, exec: Exec = db) {
  return exec
    .select({ window: featureLimits.window, max: featureLimits.maxCount })
    .from(featureLimits)
    .where(eq(featureLimits.slug, slug));
}

/** Count a user's events for a slug within one trailing window, + the oldest one. */
async function countWindow(exec: Exec, userId: string, slug: string, w: UsageWindow) {
  const [row] = await exec
    .select({
      used: sql<number>`count(*)::int`,
      oldest: sql<string | Date | null>`min(${featureUsageEvents.createdAt})`,
    })
    .from(featureUsageEvents)
    .where(
      and(
        eq(featureUsageEvents.userId, userId),
        eq(featureUsageEvents.slug, slug),
        gte(
          featureUsageEvents.createdAt,
          sql.raw(`now() - interval '${WINDOW_SQL_INTERVAL[w]}'`),
        ),
      ),
    );
  return { used: row?.used ?? 0, oldest: row?.oldest ?? null };
}

function resetAt(oldest: string | Date | null, w: UsageWindow): string | null {
  if (!oldest) return null;
  return new Date(new Date(oldest).getTime() + WINDOW_MS[w]).toISOString();
}

function toWindowUsage(
  window: UsageWindow,
  max: number,
  used: number,
  oldest: string | Date | null,
): WindowUsage {
  return { window, max, used, remaining: Math.max(0, max - used), resetAt: resetAt(oldest, window) };
}

/**
 * Read-only usage check (endpoint b). Reports whether the user still has room in
 * every configured window. Never inserts and takes no lock — advisory only, so a
 * client must not rely on it for enforcement (that's {@link consume}).
 */
export async function peek(
  userId: string,
  slug: PaidFeatureSlug,
  database: typeof db = db,
): Promise<UsageResult> {
  const limits = await loadLimits(slug, database);
  if (limits.length === 0) return { allowed: true, windows: [] };
  const windows: WindowUsage[] = [];
  for (const { window, max } of limits) {
    const { used, oldest } = await countWindow(database, userId, slug, window);
    windows.push(toWindowUsage(window, max, used, oldest));
  }
  return { allowed: windows.every((w) => w.used < w.max), windows };
}

/**
 * Atomically enforce + record one use (the guard's engine). Returns `allowed:false`
 * WITHOUT recording when any window is already at its max.
 *
 * Race-free by construction: the `pg_advisory_xact_lock` serializes every concurrent
 * consume() for this (user, slug) into a strict queue, so each call's count already
 * includes every prior committed insert — the naive count-then-insert race (two
 * requests both read 4 < 5, both insert → 6) cannot happen. The lock is transaction-
 * scoped (auto-released on commit/rollback) and keyed per (user, slug), so different
 * users/features never contend; it's held only for a few sub-ms indexed counts + one
 * insert.
 */
export async function consume(
  userId: string,
  slug: PaidFeatureSlug,
  database: typeof db = db,
): Promise<UsageResult> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${slug}`}, 0))`,
    );

    const limits = await loadLimits(slug, tx);
    if (limits.length === 0) {
      // Unconfigured = unlimited, but still record the use (audit/billing ledger).
      const [ev] = await tx
        .insert(featureUsageEvents)
        .values({ userId, slug })
        .returning({ id: featureUsageEvents.id });
      return { allowed: true, windows: [], eventId: ev!.id };
    }

    const windows: WindowUsage[] = [];
    for (const { window, max } of limits) {
      const { used, oldest } = await countWindow(tx, userId, slug, window);
      windows.push(toWindowUsage(window, max, used, oldest));
    }

    if (!windows.every((w) => w.used < w.max)) {
      return { allowed: false, windows }; // over limit → do NOT record
    }

    const [ev] = await tx
      .insert(featureUsageEvents)
      .values({ userId, slug })
      .returning({ id: featureUsageEvents.id });
    for (const w of windows) {
      w.used += 1;
      w.remaining = Math.max(0, w.max - w.used);
    }
    return { allowed: true, windows, eventId: ev!.id };
  });
}

/**
 * Undo a recorded use — for the future reserve+refund path around a real LLM call:
 * `consume()` to reserve atomically, run the work, `refund(eventId)` on failure.
 * Never consume *after* the expensive work (that reintroduces the race).
 */
export async function refund(eventId: string, database: typeof db = db): Promise<void> {
  await database.delete(featureUsageEvents).where(eq(featureUsageEvents.id, eventId));
}
