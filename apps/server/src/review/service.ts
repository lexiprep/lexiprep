// DB-facing layer for the spaced-repetition review game (spec 12). The only logic here is
// assembly + persistence; the interval math lives in the pure `intervals.ts`. A daily
// session is two sorted queries (overdue-first due cards + filtered new cards) — no
// background scheduler. Grading runs `nextReview()` inline and writes the row + a
// `reviewLog` entry in one transaction.

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  definitions,
  reviewLog,
  userSettings,
  userWordEvents,
  userWords,
  wordNotes,
  type SrsState,
  type WordSense,
} from "../db/schema.js";
import { levelRange, reviewBookAgg, GRANULARITIES, type Granularity } from "../books/service.js";
import {
  DEFAULT_CONFIG,
  nextReview,
  previewIntervals,
  type CardState,
  type IntervalPreview,
  type Rating,
} from "./intervals.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** One card in the session (the FE contract — see spec 12 §API surface). */
export interface ReviewCard {
  lemma: string;
  /** The display headword (the base form — same value as `lemma`). */
  word: string;
  example: string | null;
  level: string | null;
  /** Cached dictionary senses, or null when none exist (the card is still valid). */
  definition: WordSense[] | null;
  /** Representative book the word comes from — the note editor targets this book. Null when
   * the word no longer occurs in any of the user's books. */
  bookId: string | null;
  bookTitle: string | null;
  /** The user's own note for that book (their custom meaning), or null. */
  note: string | null;
  /** Every surface form of the lemma (for bolding the word in the context sentence). */
  forms: string[];
  state: SrsState;
  isNew: boolean;
  preview: IntervalPreview;
}

export interface SessionCounts {
  /** New cards used this session. */
  new: number;
  /** Due cards used this session. */
  due: number;
  /** Total cards in the session (new + due). */
  remaining: number;
  /** Full due backlog (≥ `due`); powers the "N more due" hint when truncated by the cap. */
  totalDue: number;
}

export interface ReviewSession {
  cards: ReviewCard[];
  counts: SessionCounts;
}

export interface SessionOptions {
  language?: string;
  /** Narrows the *new*-card pool to one book (due reviews are always global). */
  bookId?: string;
  /** CEFR range, applied to new cards only. */
  minLevel?: string;
  maxLevel?: string;
  newPerDay: number;
  maxPerDay: number;
}

export interface GradeOptions {
  language?: string;
  lemma: string;
  grade: Rating;
}

export type GradeResult =
  | { ok: false }
  | {
      ok: true;
      /** The card re-shows in this session (sub-day learning/relearning step). */
      stays: boolean;
      graduated: boolean;
      card: {
        state: SrsState;
        intervalDays: number;
        due: string | null;
        preview: IntervalPreview;
      };
    };

export interface ReviewStats {
  dayStreak: number;
  reviewedToday: number;
  reviewedAllTime: number;
  avgDaysBetween: number | null;
}

export interface ReviewTimeseriesBucket {
  period: string;
  reviews: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface ReviewTimeseries {
  granularity: Granularity;
  buckets: ReviewTimeseriesBucket[];
}

export interface ReviewTimeseriesQuery {
  from: Date;
  /** Inclusive end day. */
  to: Date;
  granularity: Granularity;
  tz?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A `user_words` row (the SRS columns) → the pure module's `CardState`. */
interface CardRow {
  id: string;
  lemma: string;
  srsState: string;
  srsDue: Date | null;
  srsIntervalDays: number;
  srsEase: number;
  srsReps: number;
  srsLapses: number;
  srsStep: number;
  srsStreak: number;
  srsPreLapseInterval: number;
  srsLastReviewed: Date | null;
}

function rowToCard(row: CardRow): CardState {
  return {
    state: row.srsState as SrsState,
    intervalDays: row.srsIntervalDays,
    ease: row.srsEase,
    reps: row.srsReps,
    lapses: row.srsLapses,
    step: row.srsStep,
    streak: row.srsStreak,
    due: row.srsDue,
    lastReviewed: row.srsLastReviewed,
    preLapseInterval: row.srsPreLapseInterval,
  };
}

/** Fuzz seed is fixed at show-time from the card's *current* due, so preview == scheduled. */
function seedFor(id: string, due: Date | null): string {
  return `${id}:${due ? due.getTime() : 0}`;
}

/**
 * Coerce sense examples to plain strings (mirrors `books/service.ts` — Open English
 * WordNet sometimes stores an example as an attributed-quote object, which the React modal
 * cannot render).
 */
function normalizeSenses(senses: WordSense[]): WordSense[] {
  return senses.map((s) => {
    const ex = s.example as unknown;
    const example =
      typeof ex === "string"
        ? ex
        : ex && typeof ex === "object" && "text" in ex
          ? String((ex as { text: unknown }).text)
          : undefined;
    return example ? { pos: s.pos, gloss: s.gloss, example } : { pos: s.pos, gloss: s.gloss };
  });
}

/** The SRS columns + the enrichment join (level/example come from the rollup `agg`). */
function cardSelect(agg: ReturnType<typeof reviewBookAgg>) {
  return {
    id: userWords.id,
    lemma: userWords.lemma,
    srsState: userWords.srsState,
    srsDue: userWords.srsDue,
    srsIntervalDays: userWords.srsIntervalDays,
    srsEase: userWords.srsEase,
    srsReps: userWords.srsReps,
    srsLapses: userWords.srsLapses,
    srsStep: userWords.srsStep,
    srsStreak: userWords.srsStreak,
    srsPreLapseInterval: userWords.srsPreLapseInterval,
    srsLastReviewed: userWords.srsLastReviewed,
    level: agg.level,
    example: agg.example,
    bookId: agg.bookId,
    bookTitle: agg.bookTitle,
    forms: agg.forms,
  };
}

// ── Session assembly ─────────────────────────────────────────────────────────

/**
 * Build today's session: all due learning cards (overdue first), then up to `newPerDay`
 * never-reviewed cards drawn highest-frequency-first from the (optionally book/level
 * filtered) Learning list, the whole thing capped at `maxPerDay`. Each card carries its
 * four button labels (`preview`), seeded so the label equals what grading will schedule.
 */
export async function buildSession(
  userId: string,
  opts: SessionOptions,
  now: Date,
): Promise<ReviewSession> {
  const language = opts.language ?? "en";
  // Due reviews enrich from the global rollup (a due word is due regardless of book);
  // new cards use a rollup narrowed by the optional book filter (the prep lever).
  const aggAll = reviewBookAgg(userId, language, undefined);
  const aggNew = reviewBookAgg(userId, language, opts.bookId);

  const dueRows = (await db
    .select(cardSelect(aggAll))
    .from(userWords)
    .leftJoin(aggAll, sql`${aggAll.lemma} = ${userWords.lemma}`)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        eq(userWords.status, "learning"),
        lte(userWords.srsDue, now),
      ),
    )
    .orderBy(asc(userWords.srsDue))
    .limit(Math.max(0, opts.maxPerDay))) as CardRowWithEnrich[];

  const [dueCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userWords)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        eq(userWords.status, "learning"),
        lte(userWords.srsDue, now),
      ),
    );
  const totalDue = dueCountRow?.n ?? 0;

  const newRows = (await db
    .select(cardSelect(aggNew))
    .from(userWords)
    .leftJoin(aggNew, sql`${aggNew.lemma} = ${userWords.lemma}`)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        eq(userWords.status, "learning"),
        isNull(userWords.srsDue),
        // New cards must occur in a book (provides the example/level + the order key).
        sql`${aggNew.lemma} is not null`,
        ...levelRange(aggNew.level, opts.minLevel, opts.maxLevel),
      ),
    )
    .orderBy(desc(aggNew.maxCount), asc(userWords.lemma))
    .limit(Math.max(0, opts.newPerDay))) as CardRowWithEnrich[];

  // Due first, then new; cap the whole session. New cards are truncated first.
  const capped = [...dueRows, ...newRows].slice(0, Math.max(0, opts.maxPerDay));

  // Cached definitions for the whole session in one query (no per-card network fetch).
  const lemmas = [...new Set(capped.map((r) => r.lemma))];
  const defRows = lemmas.length
    ? await db
        .select({ lemma: definitions.lemma, senses: definitions.senses })
        .from(definitions)
        .where(and(eq(definitions.language, language), inArray(definitions.lemma, lemmas)))
    : [];
  const defMap = new Map(defRows.map((d) => [d.lemma, d.senses]));

  // The user's per-book notes for the cards' representative books, in one query. Keyed by
  // `bookId|lemma` so a card only matches the note written for *its* book.
  const noteBookIds = [...new Set(capped.map((r) => r.bookId).filter((b): b is string => !!b))];
  const noteRows =
    lemmas.length && noteBookIds.length
      ? await db
          .select({ bookId: wordNotes.bookId, lemma: wordNotes.lemma, note: wordNotes.note })
          .from(wordNotes)
          .where(
            and(
              eq(wordNotes.userId, userId),
              inArray(wordNotes.bookId, noteBookIds),
              inArray(wordNotes.lemma, lemmas),
            ),
          )
      : [];
  const noteMap = new Map(noteRows.map((n) => [`${n.bookId}|${n.lemma}`, n.note]));

  const cards: ReviewCard[] = capped.map((row) => {
    const isNew = row.srsDue === null;
    const senses = defMap.get(row.lemma);
    return {
      lemma: row.lemma,
      word: row.lemma,
      example: row.example ?? null,
      level: row.level ?? null,
      definition: senses ? normalizeSenses(senses) : null,
      bookId: row.bookId ?? null,
      bookTitle: row.bookTitle ?? null,
      note: row.bookId ? noteMap.get(`${row.bookId}|${row.lemma}`) ?? null : null,
      forms: row.forms ?? [],
      state: row.srsState as SrsState,
      isNew,
      preview: previewIntervals(rowToCard(row), now, seedFor(row.id, row.srsDue)),
    };
  });

  const dueUsed = capped.filter((r) => r.srsDue !== null).length;
  const newUsed = capped.length - dueUsed;
  return {
    cards,
    counts: { new: newUsed, due: dueUsed, remaining: capped.length, totalDue },
  };
}

type CardRowWithEnrich = CardRow & {
  level: string | null;
  example: string | null;
  bookId: string | null;
  bookTitle: string | null;
  forms: string[];
};

// ── Grading ──────────────────────────────────────────────────────────────────

/**
 * Grade one card: load the row, run the pure `nextReview()`, persist the SRS columns and an
 * append-only `reviewLog` entry in one transaction. If the card clears the auto-graduation
 * bar (and the setting is on — already gated inside `nextReview`), flip it to `known` and log
 * a learning→known event so it counts in the "learned" series. No-ops (returns `{ok:false}`)
 * for a missing lemma or a word that is not currently `learning`.
 */
export async function gradeCard(
  userId: string,
  opts: GradeOptions,
  now: Date,
): Promise<GradeResult> {
  const language = opts.language ?? "en";
  const lemma = opts.lemma.trim().toLowerCase();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(userWords)
      .where(
        and(
          eq(userWords.userId, userId),
          eq(userWords.language, language),
          eq(userWords.lemma, lemma),
        ),
      )
      .limit(1);
    if (!row || row.status !== "learning") return { ok: false } as const;

    const [settingsRow] = await tx
      .select({ autoGraduateKnown: userSettings.autoGraduateKnown })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
    const cfg = {
      ...DEFAULT_CONFIG,
      autoGraduateKnown: settingsRow?.autoGraduateKnown ?? false,
    };

    const card = rowToCard(row);
    const seed = seedFor(row.id, row.srsDue);
    const result = nextReview(card, opts.grade, now, seed, cfg);
    const c = result.card;

    await tx
      .update(userWords)
      .set({
        srsState: c.state,
        srsDue: c.due,
        srsIntervalDays: c.intervalDays,
        srsEase: c.ease,
        srsReps: c.reps,
        srsLapses: c.lapses,
        srsStep: c.step,
        srsStreak: c.streak,
        srsPreLapseInterval: c.preLapseInterval,
        srsLastReviewed: now,
        updatedAt: now,
        ...(result.graduateToKnown ? { status: "known" } : {}),
      })
      .where(eq(userWords.id, row.id));

    await tx.insert(reviewLog).values({
      userId,
      userWordId: row.id,
      rating: opts.grade,
      stateBefore: result.log.stateBefore,
      elapsedDays: result.log.elapsedDays,
      scheduledDays: result.log.scheduledDays,
      intervalAfter: result.log.intervalAfter,
      easeAfter: result.log.easeAfter,
    });

    if (result.graduateToKnown) {
      await tx.insert(userWordEvents).values({
        userId,
        language,
        lemma: row.lemma,
        fromStatus: "learning",
        toStatus: "known",
        source: "learning",
      });
    }

    return {
      ok: true,
      stays: c.state === "learning" || c.state === "relearning",
      graduated: result.graduateToKnown,
      card: {
        state: c.state,
        intervalDays: c.intervalDays,
        due: c.due ? c.due.toISOString() : null,
        // Re-show preview seeds from the NEW due (the card's freshly-fixed show-time seed).
        preview: previewIntervals(c, now, seedFor(row.id, c.due)),
      },
    } as const;
  });
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * A SQL literal for the timezone, safe to inline. The same `... at time zone <tz>`
 * expression must appear textually in SELECT, GROUP BY and ORDER BY for Postgres to treat
 * it as one grouped expression — a bind param gets renumbered per clause and breaks that
 * (the same reason `getVocabularyTimeseries` inlines its granularity). IANA zone names are
 * limited to `[A-Za-z0-9_+/-]`, so anything else falls back to UTC (no injection surface).
 */
function tzLiteral(tz: string): string {
  const safe = /^[A-Za-z0-9_+\-/]+$/.test(tz) ? tz : "UTC";
  return `'${safe}'`;
}

/** Today's local calendar date (YYYY-MM-DD) in `tz`, computed from the wall clock. */
function localToday(tz: string): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  try {
    return fmt(tz);
  } catch {
    return fmt("UTC");
  }
}

/** Previous calendar day for a YYYY-MM-DD string (plain date arithmetic, DST-agnostic). */
function prevDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Consecutive local-calendar days with ≥1 review, anchored on today (or yesterday). */
function computeStreak(datesDesc: string[], today: string): number {
  if (datesDesc.length === 0) return 0;
  const set = new Set(datesDesc);
  const yesterday = prevDay(today);
  let cursor = set.has(today) ? today : set.has(yesterday) ? yesterday : null;
  if (cursor === null) return 0; // most recent review is older than yesterday → streak broken
  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = prevDay(cursor);
  }
  return streak;
}

/**
 * Game stats from `reviewLog`: the day streak (the headline stat — consecutive local days
 * with a review), reviews today / all-time, and the mean days between recent review-phase
 * answers (an FSRS-style spacing signal; null when there are none).
 */
export async function getReviewStats(userId: string, tz = "UTC"): Promise<ReviewStats> {
  const localDate = sql<string>`to_char((${reviewLog.reviewedAt} at time zone ${sql.raw(tzLiteral(tz))})::date, 'YYYY-MM-DD')`;
  const today = localToday(tz);

  const dateRows = await db
    .select({ d: localDate })
    .from(reviewLog)
    .where(eq(reviewLog.userId, userId))
    .groupBy(localDate)
    .orderBy(desc(localDate));
  const dayStreak = computeStreak(
    dateRows.map((r) => r.d),
    today,
  );

  const [todayRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewLog)
    .where(and(eq(reviewLog.userId, userId), sql`${localDate} = ${today}`));
  const reviewedToday = todayRow?.n ?? 0;

  const [allRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewLog)
    .where(eq(reviewLog.userId, userId));
  const reviewedAllTime = allRow?.n ?? 0;

  // Mean elapsed-days over the most recent review-phase grades (Again/Hard/Good/Easy from
  // the `review` state — the answers with a meaningful inter-review gap).
  const recent = db
    .select({ elapsedDays: reviewLog.elapsedDays })
    .from(reviewLog)
    .where(
      and(
        eq(reviewLog.userId, userId),
        eq(reviewLog.stateBefore, "review"),
        sql`${reviewLog.elapsedDays} is not null`,
      ),
    )
    .orderBy(desc(reviewLog.reviewedAt))
    .limit(100)
    .as("recent");
  const [avgRow] = await db
    .select({ avg: sql<number | null>`avg(${recent.elapsedDays})::float8` })
    .from(recent);
  const avgDaysBetween = avgRow?.avg ?? null;

  return { dayStreak, reviewedToday, reviewedAllTime, avgDaysBetween };
}

/**
 * Reviews per period with an Again/Hard/Good/Easy breakdown, bucketed in the user's local
 * timezone (mirrors `getVocabularyTimeseries`'s shape so the Stats chart reuses its pattern).
 */
export async function getReviewTimeseries(
  userId: string,
  q: ReviewTimeseriesQuery,
): Promise<ReviewTimeseries> {
  const tz = q.tz ?? "UTC";
  const unit: Granularity = GRANULARITIES.includes(q.granularity) ? q.granularity : "day";
  const toExclusive = new Date(q.to.getTime() + 24 * 60 * 60 * 1000); // include the `to` day
  const localTs = sql`(${reviewLog.reviewedAt} at time zone ${sql.raw(tzLiteral(tz))})`;
  const trunc = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${localTs})`;

  const rows = await db
    .select({
      period: sql<string>`to_char(${trunc}, 'YYYY-MM-DD')`,
      rating: reviewLog.rating,
      n: sql<number>`count(*)::int`,
    })
    .from(reviewLog)
    .where(
      and(
        eq(reviewLog.userId, userId),
        gte(reviewLog.reviewedAt, q.from),
        lt(reviewLog.reviewedAt, toExclusive),
      ),
    )
    .groupBy(trunc, reviewLog.rating)
    .orderBy(trunc);

  const byPeriod = new Map<string, ReviewTimeseriesBucket>();
  const bucketFor = (period: string): ReviewTimeseriesBucket => {
    let b = byPeriod.get(period);
    if (!b) {
      b = { period, reviews: 0, again: 0, hard: 0, good: 0, easy: 0 };
      byPeriod.set(period, b);
    }
    return b;
  };
  const KEY = { 1: "again", 2: "hard", 3: "good", 4: "easy" } as const;
  for (const r of rows) {
    const b = bucketFor(r.period);
    b.reviews += r.n;
    const key = KEY[r.rating as 1 | 2 | 3 | 4];
    if (key) b[key] += r.n;
  }

  return {
    granularity: q.granularity,
    buckets: [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period)),
  };
}
