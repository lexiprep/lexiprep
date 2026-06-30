import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import {
  buildSession,
  gradeCard,
  getReviewStats,
  getReviewTimeseries,
} from "../src/review/service.js";
import { getSettings, upsertSettings, DEFAULT_SETTINGS } from "../src/review/settings.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

const { userWords, reviewLog, userWordEvents } = schema;

const DAY = 24 * 60 * 60 * 1000;

let userId: string;

beforeEach(async () => {
  userId = await createUser();
});

async function userWordRow(lemma: string) {
  const [row] = await db
    .select()
    .from(userWords)
    .where(and(eq(userWords.userId, userId), eq(userWords.lemma, lemma)));
  if (!row) throw new Error(`no user_words row for "${lemma}"`);
  return row;
}

// ── Session assembly ──────────────────────────────────────────────────────────

describe("buildSession — new cards", () => {
  it("orders new cards by max single-book count desc and honours newPerDay", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "alpha", lemma: "alpha", count: 100, level: "A1", example: "alpha ex" },
      { word: "beta", lemma: "beta", count: 50, level: "B1" },
      { word: "gamma", lemma: "gamma", count: 10, level: "C1" },
      { word: "delta", lemma: "delta", count: 5, level: "A2" },
    ]);
    for (const w of ["alpha", "beta", "gamma", "delta"]) {
      await setUserWord(userId, "en", w, "learning");
    }

    const session = await buildSession(userId, { newPerDay: 2, maxPerDay: 200 }, new Date());
    expect(session.cards.map((c) => c.lemma)).toEqual(["alpha", "beta"]);
    expect(session.counts).toMatchObject({ new: 2, due: 0, remaining: 2, totalDue: 0 });
    expect(session.cards[0]).toMatchObject({
      lemma: "alpha",
      word: "alpha",
      level: "A1",
      example: "alpha ex",
      isNew: true,
      state: "new",
    });
    // New-card preview: the sub-day grades are exact; Easy graduates to ~4d (fuzzed ±15%).
    expect(session.cards[0]!.preview).toMatchObject({ again: "1m", hard: "1m", good: "10m" });
    expect(session.cards[0]!.preview.easy).toMatch(/^[345]d$/);
  });

  it("applies the CEFR range to the new-card pool", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "alpha", lemma: "alpha", count: 100, level: "A1" },
      { word: "beta", lemma: "beta", count: 50, level: "B1" },
      { word: "gamma", lemma: "gamma", count: 10, level: "C1" },
      { word: "delta", lemma: "delta", count: 5, level: "A2" },
    ]);
    for (const w of ["alpha", "beta", "gamma", "delta"]) {
      await setUserWord(userId, "en", w, "learning");
    }

    const session = await buildSession(
      userId,
      { newPerDay: 10, maxPerDay: 200, minLevel: "A1", maxLevel: "A2" },
      new Date(),
    );
    expect(session.cards.map((c) => c.lemma)).toEqual(["alpha", "delta"]);
  });

  it("narrows the new-card pool to the chosen book", async () => {
    const bookA = await createBook(userId, { title: "A", language: "en" });
    const bookB = await createBook(userId, { title: "B", language: "en" });
    await addBookWords(bookA.id, [{ word: "apple", lemma: "apple", count: 10, level: "A1" }]);
    await addBookWords(bookB.id, [{ word: "banana", lemma: "banana", count: 20, level: "A1" }]);
    await setUserWord(userId, "en", "apple", "learning");
    await setUserWord(userId, "en", "banana", "learning");

    const session = await buildSession(
      userId,
      { newPerDay: 10, maxPerDay: 200, bookId: bookA.id },
      new Date(),
    );
    expect(session.cards.map((c) => c.lemma)).toEqual(["apple"]);
  });
});

describe("buildSession — due cards", () => {
  it("returns due cards most-overdue first, before new cards", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "older", lemma: "older", count: 3, level: "A1", example: "older ex" },
      { word: "newer", lemma: "newer", count: 3, level: "A1" },
    ]);
    const now = new Date();
    await setUserWord(userId, "en", "older", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - 2 * DAY),
      srsIntervalDays: 5,
      srsEase: 2.5,
      srsReps: 2,
    });
    await setUserWord(userId, "en", "newer", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - 1 * DAY),
      srsIntervalDays: 5,
      srsEase: 2.5,
      srsReps: 2,
    });

    const session = await buildSession(userId, { newPerDay: 0, maxPerDay: 200 }, now);
    expect(session.cards.map((c) => c.lemma)).toEqual(["older", "newer"]);
    expect(session.cards.every((c) => !c.isNew)).toBe(true);
    expect(session.counts).toMatchObject({ new: 0, due: 2, remaining: 2, totalDue: 2 });
  });

  it("caps the session at maxPerDay (due first, new truncated) and reports totalDue", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "due1", lemma: "due1", count: 3, level: "A1" },
      { word: "due2", lemma: "due2", count: 3, level: "A1" },
      { word: "new1", lemma: "new1", count: 100, level: "A1" },
      { word: "new2", lemma: "new2", count: 50, level: "A1" },
    ]);
    const now = new Date();
    await setUserWord(userId, "en", "due1", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - 3 * DAY),
      srsIntervalDays: 5,
      srsEase: 2.5,
    });
    await setUserWord(userId, "en", "due2", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - 2 * DAY),
      srsIntervalDays: 5,
      srsEase: 2.5,
    });
    await setUserWord(userId, "en", "new1", "learning");
    await setUserWord(userId, "en", "new2", "learning");

    const session = await buildSession(userId, { newPerDay: 20, maxPerDay: 3 }, now);
    expect(session.cards.map((c) => c.lemma)).toEqual(["due1", "due2", "new1"]);
    expect(session.counts).toMatchObject({ new: 1, due: 2, remaining: 3, totalDue: 2 });
  });

  it("never surfaces a known word as due", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "keep", lemma: "keep", count: 3, level: "A1" },
      { word: "gone", lemma: "gone", count: 3, level: "A1" },
    ]);
    const now = new Date();
    const past = new Date(now.getTime() - DAY);
    await setUserWord(userId, "en", "keep", "learning", {
      srsState: "review",
      srsDue: past,
      srsIntervalDays: 5,
      srsEase: 2.5,
    });
    await setUserWord(userId, "en", "gone", "known", {
      srsState: "review",
      srsDue: past,
      srsIntervalDays: 5,
      srsEase: 2.5,
    });

    const session = await buildSession(userId, { newPerDay: 0, maxPerDay: 200 }, now);
    expect(session.cards.map((c) => c.lemma)).toEqual(["keep"]);
  });
});

// ── Grading ───────────────────────────────────────────────────────────────────

describe("gradeCard", () => {
  it("persists the new SRS state and writes a review-log row", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [
      { word: "word1", lemma: "word1", count: 10, level: "A1", example: "ctx" },
    ]);
    await setUserWord(userId, "en", "word1", "learning"); // a fresh `new` card

    const now = new Date();
    const res = await gradeCard(userId, { lemma: "word1", grade: 3 }, now);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.stays).toBe(true); // new + Good → advances a sub-day learning step
    expect(res.graduated).toBe(false);
    expect(res.card.state).toBe("learning");

    const row = await userWordRow("word1");
    expect(row.srsState).toBe("learning");
    expect(row.srsStep).toBe(1);
    expect(row.srsDue).not.toBeNull();
    expect(row.srsLastReviewed).not.toBeNull();

    const logs = await db.select().from(reviewLog).where(eq(reviewLog.userId, userId));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ rating: 3, stateBefore: "new", userWordId: row.id });
  });

  it("lapses a review card to relearning on Again", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [{ word: "lapse", lemma: "lapse", count: 5, level: "B1" }]);
    const now = new Date();
    await setUserWord(userId, "en", "lapse", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - DAY),
      srsIntervalDays: 30,
      srsEase: 2.6,
      srsReps: 5,
      srsStreak: 4,
      srsLastReviewed: new Date(now.getTime() - 30 * DAY),
    });

    const res = await gradeCard(userId, { lemma: "lapse", grade: 1 }, now);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.stays).toBe(true);
    expect(res.card.state).toBe("relearning");

    const row = await userWordRow("lapse");
    expect(row.srsState).toBe("relearning");
    expect(row.srsLapses).toBe(1);
    expect(row.srsStreak).toBe(0);
    expect(row.srsEase).toBeCloseTo(2.4, 4); // 2.6 − 0.20
    expect(row.srsPreLapseInterval).toBe(30);

    const logs = await db.select().from(reviewLog).where(eq(reviewLog.userId, userId));
    expect(logs[0]).toMatchObject({ rating: 1, stateBefore: "review" });
  });

  it("auto-graduates to known when enabled and the bar is met", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [{ word: "mastered", lemma: "mastered", count: 5, level: "A1" }]);
    await upsertSettings(userId, { autoGraduateKnown: true });
    const now = new Date();
    await setUserWord(userId, "en", "mastered", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - DAY),
      srsIntervalDays: 300,
      srsEase: 3.0,
      srsReps: 7,
      srsStreak: 3,
      srsLastReviewed: new Date(now.getTime() - 300 * DAY),
    });

    const res = await gradeCard(userId, { lemma: "mastered", grade: 3 }, now);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.graduated).toBe(true);

    expect((await userWordRow("mastered")).status).toBe("known");
    const events = await db
      .select()
      .from(userWordEvents)
      .where(eq(userWordEvents.userId, userId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: "learning",
      toStatus: "known",
      source: "learning",
    });
  });

  it("does not auto-graduate below the streak bar", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [{ word: "nope", lemma: "nope", count: 5, level: "A1" }]);
    await upsertSettings(userId, { autoGraduateKnown: true });
    const now = new Date();
    await setUserWord(userId, "en", "nope", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - DAY),
      srsIntervalDays: 300,
      srsEase: 3.0,
      srsReps: 7,
      srsStreak: 1, // → 2 after Good, below KNOWN_STREAK (3)
      srsLastReviewed: new Date(now.getTime() - 300 * DAY),
    });

    const res = await gradeCard(userId, { lemma: "nope", grade: 3 }, now);
    if (!res.ok) throw new Error("unreachable");
    expect(res.graduated).toBe(false);
    expect((await userWordRow("nope")).status).toBe("learning");
  });

  it("never auto-graduates while the setting is off (default)", async () => {
    const book = await createBook(userId, { language: "en" });
    await addBookWords(book.id, [{ word: "off", lemma: "off", count: 5, level: "A1" }]);
    const now = new Date();
    await setUserWord(userId, "en", "off", "learning", {
      srsState: "review",
      srsDue: new Date(now.getTime() - DAY),
      srsIntervalDays: 300,
      srsEase: 3.0,
      srsReps: 7,
      srsStreak: 3,
      srsLastReviewed: new Date(now.getTime() - 300 * DAY),
    });

    const res = await gradeCard(userId, { lemma: "off", grade: 3 }, now);
    if (!res.ok) throw new Error("unreachable");
    expect(res.graduated).toBe(false);
    expect((await userWordRow("off")).status).toBe("learning");
  });

  it("no-ops for an unknown or non-learning word", async () => {
    expect(await gradeCard(userId, { lemma: "ghost", grade: 3 }, new Date())).toEqual({
      ok: false,
    });
    await setUserWord(userId, "en", "knownw", "known");
    expect(await gradeCard(userId, { lemma: "knownw", grade: 3 }, new Date())).toEqual({
      ok: false,
    });
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe("settings", () => {
  it("returns the defaults when no row exists", async () => {
    expect(await getSettings(userId)).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a partial patch, preserving untouched fields and clamping", async () => {
    const s1 = await upsertSettings(userId, { newPerDay: 5, autoGraduateKnown: true });
    expect(s1).toMatchObject({
      newPerDay: 5,
      maxPerDay: 200,
      autoGraduateKnown: true,
      timezone: null,
    });

    const s2 = await upsertSettings(userId, {
      newPerDay: 99999,
      maxPerDay: 0,
      timezone: "Europe/Zurich",
    });
    expect(s2.newPerDay).toBe(1000); // clamped to [0, 1000]
    expect(s2.maxPerDay).toBe(1); // clamped to [1, 1000]
    expect(s2.timezone).toBe("Europe/Zurich");
    expect(s2.autoGraduateKnown).toBe(true); // preserved across the partial update
  });

  it("rejects an invalid timezone and clears it with null", async () => {
    await expect(upsertSettings(userId, { timezone: "Mars/Phobos" })).rejects.toThrow();
    await upsertSettings(userId, { timezone: "Europe/Zurich" });
    expect((await upsertSettings(userId, { timezone: null })).timezone).toBeNull();
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

async function seedReview(
  lemma: string,
  reviewedAt: Date,
  opts: { rating?: number; stateBefore?: string; elapsedDays?: number | null } = {},
): Promise<void> {
  const existing = await db
    .select({ id: userWords.id })
    .from(userWords)
    .where(and(eq(userWords.userId, userId), eq(userWords.lemma, lemma)));
  let id = existing[0]?.id;
  if (!id) {
    await setUserWord(userId, "en", lemma, "learning");
    id = (await userWordRow(lemma)).id;
  }
  await db.insert(reviewLog).values({
    userId,
    userWordId: id,
    rating: opts.rating ?? 3,
    stateBefore: opts.stateBefore ?? "review",
    elapsedDays: opts.elapsedDays ?? null,
    reviewedAt,
  });
}

describe("getReviewStats", () => {
  it("counts a day streak of consecutive days ending today", async () => {
    const now = new Date();
    await seedReview("a", now);
    await seedReview("b", new Date(now.getTime() - 1 * DAY));
    await seedReview("c", new Date(now.getTime() - 2 * DAY));

    const stats = await getReviewStats(userId, "UTC");
    expect(stats.dayStreak).toBe(3);
    expect(stats.reviewedAllTime).toBe(3);
    expect(stats.reviewedToday).toBe(1);
  });

  it("keeps an active streak anchored on yesterday", async () => {
    const now = new Date();
    await seedReview("y1", new Date(now.getTime() - 1 * DAY));
    await seedReview("y2", new Date(now.getTime() - 2 * DAY));
    expect((await getReviewStats(userId, "UTC")).dayStreak).toBe(2);
  });

  it("breaks the streak when the latest review is older than yesterday", async () => {
    const now = new Date();
    await seedReview("x", new Date(now.getTime() - 3 * DAY));
    expect((await getReviewStats(userId, "UTC")).dayStreak).toBe(0);
  });

  it("averages elapsedDays over review-phase logs only", async () => {
    const now = new Date();
    await seedReview("p", now, { stateBefore: "review", elapsedDays: 4 });
    await seedReview("q", now, { stateBefore: "review", elapsedDays: 6 });
    await seedReview("r", now, { stateBefore: "learning", elapsedDays: 100 }); // excluded
    expect((await getReviewStats(userId, "UTC")).avgDaysBetween).toBeCloseTo(5, 5);
  });

  it("reports a null average with no review-phase logs", async () => {
    await seedReview("only", new Date(), { stateBefore: "new", elapsedDays: null });
    expect((await getReviewStats(userId, "UTC")).avgDaysBetween).toBeNull();
  });
});

describe("getReviewTimeseries", () => {
  it("buckets reviews per day with a grade breakdown", async () => {
    const now = new Date();
    await seedReview("g1", now, { rating: 3 });
    await seedReview("g2", now, { rating: 3 });
    await seedReview("a1", now, { rating: 1 });

    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const ts = await getReviewTimeseries(userId, {
      from: new Date(today.getTime() - 6 * DAY),
      to: today,
      granularity: "day",
      tz: "UTC",
    });
    expect(ts.granularity).toBe("day");
    const bucket = ts.buckets.find((b) => b.period === today.toISOString().slice(0, 10));
    expect(bucket).toMatchObject({ reviews: 3, good: 2, again: 1, hard: 0, easy: 0 });
  });
});
