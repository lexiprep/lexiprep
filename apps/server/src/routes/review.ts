import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import { GRANULARITIES, type Granularity } from "../books/service.js";
import {
  buildSession,
  gradeCard,
  getReviewStats,
  getReviewTimeseries,
} from "../review/service.js";
import { getSettings } from "../review/settings.js";
import type { Rating } from "../review/intervals.js";

const DEFAULT_LANGUAGE = "en";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// CEFR bounds the session filter accepts; `none` selects the unleveled band (spec 03/12).
const LEVEL_TOKENS = new Set(["A1", "A2", "B1", "B2", "C1", "C2", "none"]);
function isLevelToken(v: string | undefined): boolean {
  return v === undefined || v === "" || LEVEL_TOKENS.has(v);
}

/** Parse a non-negative integer query param; returns null for absent/invalid (→ use default). */
function intParam(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The card-review game (spec 12): assemble today's session, grade a card, and read the game
 * stats. All session-scoped to the signed-in user; the next-due date is computed inline at
 * grade time (no background scheduler).
 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Today's session: due cards (overdue first) + a budget of new cards (freq-ordered,
  // filtered by the optional book/CEFR range), capped at maxPerDay. Plus the day streak.
  app.get("/review/session", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q.bookId !== undefined && q.bookId !== "" && !UUID_RE.test(q.bookId)) {
      reply.code(400);
      return { error: "bookId must be a valid id" };
    }
    if (!isLevelToken(q.minLevel) || !isLevelToken(q.maxLevel)) {
      reply.code(400);
      return { error: `minLevel/maxLevel must be one of ${[...LEVEL_TOKENS].join(", ")}` };
    }
    const settings = await getSettings(request.user!.id);
    const now = new Date();
    const session = await buildSession(
      request.user!.id,
      {
        language: q.language ?? DEFAULT_LANGUAGE,
        bookId: q.bookId || undefined,
        minLevel: q.minLevel || undefined,
        maxLevel: q.maxLevel || undefined,
        newPerDay: intParam(q.newPerDay) ?? settings.newPerDay,
        maxPerDay: intParam(q.maxPerDay) ?? settings.maxPerDay,
      },
      now,
    );
    const stats = await getReviewStats(request.user!.id, settings.timezone ?? "UTC");
    return { ...session, streak: stats.dayStreak };
  });

  // Grade one card; persists the new SRS state + a review-log row, returns the re-show info.
  app.post("/review/grade", async (request, reply) => {
    const body = (request.body ?? {}) as { lemma?: string; grade?: unknown; language?: string };
    if (!body.lemma || !body.lemma.trim()) {
      reply.code(400);
      return { error: "`lemma` is required" };
    }
    const grade = body.grade;
    if (grade !== 1 && grade !== 2 && grade !== 3 && grade !== 4) {
      reply.code(400);
      return { error: "`grade` must be 1, 2, 3, or 4" };
    }
    const now = new Date();
    const result = await gradeCard(
      request.user!.id,
      { language: body.language ?? DEFAULT_LANGUAGE, lemma: body.lemma, grade: grade as Rating },
      now,
    );
    if (!result.ok) {
      reply.code(404);
      return { error: "No learning card for that word" };
    }
    return { stays: result.stays, graduated: result.graduated, card: result.card };
  });

  // Game stats: day streak (headline), reviewed today/all-time, avg days between reviews.
  app.get("/review/stats", async (request) => {
    const settings = await getSettings(request.user!.id);
    return getReviewStats(request.user!.id, settings.timezone ?? "UTC");
  });

  // Reviews-per-period (Again/Hard/Good/Easy breakdown) for the Stats chart.
  app.get("/review/stats/timeseries", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const granularity = (q.granularity ?? "day") as Granularity;
    if (!(GRANULARITIES as readonly string[]).includes(granularity)) {
      reply.code(400);
      return { error: `granularity must be one of ${GRANULARITIES.join(", ")}` };
    }
    const parseDay = (s: string | undefined): Date | null => {
      if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
      const d = new Date(`${s}T00:00:00.000Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const now = new Date();
    const to =
      parseDay(q.to) ??
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = parseDay(q.from) ?? new Date(to.getTime() - 89 * 24 * 60 * 60 * 1000); // 90 days
    if (from > to) {
      reply.code(400);
      return { error: "`from` must be on or before `to`" };
    }
    const settings = await getSettings(request.user!.id);
    return getReviewTimeseries(request.user!.id, {
      from,
      to,
      granularity,
      tz: settings.timezone ?? "UTC",
    });
  });
}
