import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  real,
  smallint,
  bigserial,
  boolean,
  timestamp,
  unique,
  index,
  customType,
  jsonb,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.js";

// Re-export Better Auth tables so the whole schema is reachable from one module.
export * from "./auth-schema.js";

/** Postgres bytea <-> Node Buffer. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * A book, owned by the user who uploaded it (per-user model — no cross-user
 * dedup for now). The frequency list lives in {@link bookWords}.
 */
export const books = pgTable("books", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  author: text("author"),
  translator: text("translator"),
  language: text("language").notNull().default("en"),
  /** EPUB dc:identifier, stored for reference (not a dedup key). */
  identifier: text("identifier"),
  sourceFilename: text("source_filename"),
  /** uploaded | processing | ready | failed */
  status: text("status").notNull().default("uploaded"),
  error: text("error"),
  chapterCount: integer("chapter_count"),
  tokenCount: integer("token_count"),
  /** Set when the user has triaged this book's unique words. */
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** Stamped each time the user opens this book; most-recently-opened sorts the list first. */
  lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One distinct word per book with its occurrence count. */
export const bookWords = pgTable(
  "book_words",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    word: text("word").notNull(),
    /** Base form once lemmatization runs (phase 2); null until then. */
    lemma: text("lemma"),
    count: integer("count").notNull(),
    /** CEFR level, set during enrichment (phase 3); null until then. */
    level: text("level"),
    /** One context sentence for this surface form (captured in core); null until then. */
    example: text("example"),
    isStopword: boolean("is_stopword").notNull().default(false),
    /**
     * Capitalization-based proper-noun class (spec 06): `confirmed` (name, ≥2 mid-sentence
     * caps) or `likely` (1 mid-sentence cap); null otherwise. Book-scoped, set by core.
     * `confirmed` names without a vetted level are auto-ignored at processing.
     */
    properNoun: text("proper_noun"),
  },
  (t) => [
    unique("book_words_book_word_uniq").on(t.bookId, t.word),
    index("book_words_book_count_idx").on(t.bookId, t.count),
  ],
);

/**
 * The user's vocabulary state, scoped by language. One row per word the user has
 * classified; an untriaged word has no row (that's the review queue). Cross-book —
 * classify a word once and it's resolved in every book. Matched on
 * {@link bookWords.lemma} ?? {@link bookWords.word}. See spec 05.
 *
 * `status` is a degree of familiarity:
 *  - `learning` — flagged to study (study list / Anki export)
 *  - `known`    — mastered → hidden from the queue
 *  - `ignored`  — never want to see (names, proper nouns) → hidden
 */
export const USER_WORD_STATUSES = ["learning", "known", "ignored"] as const;
export type UserWordStatus = (typeof USER_WORD_STATUSES)[number];

/**
 * Spaced-repetition card state (spec 12). The `srs*` columns on {@link userWords} are
 * meaningful only while `status = 'learning'`:
 *  - `new`        — never reviewed; flows into the daily new-card budget
 *  - `learning`   — running the sub-day learning step ladder
 *  - `review`     — graduated to day-level intervals
 *  - `relearning` — lapsed back to the short relearning ladder
 */
export const SRS_STATES = ["new", "learning", "review", "relearning"] as const;
export type SrsState = (typeof SRS_STATES)[number];

export const userWords = pgTable(
  "user_words",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    lemma: text("lemma").notNull(),
    status: text("status").notNull(),
    // --- SRS card state (spec 12); meaningful only while status = 'learning'. ---
    /** new | learning | review | relearning ({@link SRS_STATES}). */
    srsState: text("srs_state").notNull().default("new"),
    /** Next due time; null until the card is first scheduled. Drives the due index. */
    srsDue: timestamp("srs_due", { withTimezone: true }),
    /** Last scheduled review interval, in days. */
    srsIntervalDays: real("srs_interval_days").notNull().default(0),
    /** Ease multiplier (SM-2 ease factor). */
    srsEase: real("srs_ease").notNull().default(2.5),
    /** Successful review-phase answers. */
    srsReps: integer("srs_reps").notNull().default(0),
    /** Times the card fell back to relearning. */
    srsLapses: integer("srs_lapses").notNull().default(0),
    /** Index into the learning/relearning step ladder. */
    srsStep: integer("srs_step").notNull().default(0),
    /** Consecutive Good/Easy answers (for auto-graduation to known). */
    srsStreak: integer("srs_streak").notNull().default(0),
    /** Interval before the last lapse, in days (relearning graduation input). */
    srsPreLapseInterval: real("srs_pre_lapse_interval").notNull().default(0),
    /** Last review time; null until first reviewed. */
    srsLastReviewed: timestamp("srs_last_reviewed", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("user_words_user_lang_lemma_uniq").on(t.userId, t.language, t.lemma),
    // The daily "what's due" query: due learning cards for a user, oldest-first.
    index("user_words_due_idx").on(t.userId, t.status, t.srsDue),
  ],
);

/**
 * Which UI surface triggered a status change. `user_words.status` is the *current* state
 * and overwrites in place, so the only way to tell a deliberate study action from a
 * book-page triage correction is to record the origin here:
 *  - `learning` — the cross-book Learning page (the deliberate "I've studied it" action)
 *  - `book`     — a book's review page (triage; learning→known here is a correction, not
 *                 a learned word — see {@link userWordEvents} and the "learned" series)
 */
export const WORD_EVENT_SOURCES = ["book", "learning"] as const;
export type WordEventSource = (typeof WORD_EVENT_SOURCES)[number];

/**
 * Append-only audit log of every {@link userWords} status transition. `user_words` keeps
 * only the latest status (last-write-wins), so this table is the history: it lets us tell
 * that a word went learning → known (and *where* it happened), which `user_words` alone
 * cannot. A word is "learned" when it transitions `learning` → `known` with
 * `source = 'learning'`; a learning→known done from a book page is triage, not learning.
 * No backfill exists for pre-existing words, so history starts accumulating from rollout.
 */
export const userWordEvents = pgTable(
  "user_word_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    lemma: text("lemma").notNull(),
    /** Status before the change; null when the word had no prior `user_words` row. */
    fromStatus: text("from_status"),
    /** Status after the change; null when the word's row was cleared (deleted). */
    toStatus: text("to_status"),
    source: text("source").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_word_events_user_lemma_idx").on(t.userId, t.language, t.lemma),
    // Serves the "learned" timeseries (filter on user+to_status, bucket by time).
    index("user_word_events_learned_idx").on(t.userId, t.toStatus, t.at),
  ],
);

/**
 * Append-only audit of every spaced-repetition grade (spec 12). One row per graded card.
 * `userWords` keeps only the card's *current* SRS state (last-write-wins), so this table
 * is the history: `(rating, elapsedDays, reviewedAt)` per card is exactly what an FSRS
 * optimizer consumes — logging it keeps the FSRS swap a real future option — and it is the
 * source for the review stats (day streak, reviewed today/all-time, avg time between).
 */
export const reviewLog = pgTable(
  "review_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    userWordId: uuid("user_word_id")
      .notNull()
      .references(() => userWords.id, { onDelete: "cascade" }),
    /** 1 Again, 2 Hard, 3 Good, 4 Easy. */
    rating: smallint("rating").notNull(),
    /** SRS state before this grade was applied. */
    stateBefore: text("state_before"),
    /** Days since the card's previous review (FSRS input; also "avg time between"). */
    elapsedDays: real("elapsed_days"),
    /** The interval that had been due (lateness analysis). */
    scheduledDays: real("scheduled_days"),
    /** Interval after applying this grade, in days. */
    intervalAfter: real("interval_after"),
    /** Ease after applying this grade. */
    easeAfter: real("ease_after"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_log_user_reviewed_idx").on(t.userId, t.reviewedAt)],
);

/**
 * Per-user settings (spec 12 — the first settings table in the app). One row per user,
 * created lazily on first write; reads fall back to the column defaults when absent.
 */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** New cards introduced per daily session. */
  newPerDay: integer("new_per_day").notNull().default(20),
  /** Total cards (new + due) per daily session. */
  maxPerDay: integer("max_per_day").notNull().default(200),
  /** Opt-in: retire a card to `known` once it clears the high recall bar. */
  autoGraduateKnown: boolean("auto_graduate_known").notNull().default(false),
  /** IANA timezone for the day boundary + streak; null → UTC fallback. */
  timezone: text("timezone"),
});

/** The raw uploaded EPUB bytes, kept so any worker can (re)process it. */
export const bookFiles = pgTable("book_files", {
  bookId: uuid("book_id")
    .primaryKey()
    .references(() => books.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Bundled open CEFR wordlist (spec 03). One row per (language, lemma): the level at
 * which that lemma is first introduced (MIN across POS rows in the source). Loaded once
 * via `db:seed` from data/cefr/en.csv; `book_words.level` is populated by looking words
 * up here. Matched against coalesce(book_words.lemma, book_words.word), so coverage
 * jumps automatically once lemmatization fills `book_words.lemma`.
 */
export const wordLevels = pgTable(
  "word_levels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    language: text("language").notNull(),
    lemma: text("lemma").notNull(),
    level: text("level").notNull(),
    source: text("source").notNull(),
  },
  (t) => [unique("word_levels_lang_lemma_uniq").on(t.language, t.lemma)],
);

/** One short dictionary sense. Glosses are kept concise; a word has a few. */
export interface WordSense {
  pos: string;
  gloss: string;
  example?: string;
}

/**
 * Bundled dictionary, keyed by (language, lemma). Populated/updated by
 * `make dict-update` (downloads Open English WordNet, upserts — never deletes, so there
 * is no availability gap). Looked up by `getWordDetail` and matched against
 * `book_words.lemma`. See spec 03.
 */
export const definitions = pgTable(
  "definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    language: text("language").notNull(),
    lemma: text("lemma").notNull(),
    senses: jsonb("senses").notNull().$type<WordSense[]>(),
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("definitions_lang_lemma_uniq").on(t.language, t.lemma)],
);

export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;
export type BookWord = typeof bookWords.$inferSelect;
export type NewBookWord = typeof bookWords.$inferInsert;
export type UserWord = typeof userWords.$inferSelect;
export type NewUserWord = typeof userWords.$inferInsert;
export type UserWordEvent = typeof userWordEvents.$inferSelect;
export type NewUserWordEvent = typeof userWordEvents.$inferInsert;
/**
 * A user's own note on a word, scoped to one book — the word may carry a specific
 * meaning in that book's context. Shown in the modal as an addition to the dictionary
 * senses (not a replacement). Keyed by the base form (lemma).
 */
export const wordNotes = pgTable(
  "word_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    lemma: text("lemma").notNull(),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("word_notes_user_book_lemma_uniq").on(t.userId, t.bookId, t.lemma)],
);

export type WordLevel = typeof wordLevels.$inferSelect;
export type NewWordLevel = typeof wordLevels.$inferInsert;
export type Definition = typeof definitions.$inferSelect;
export type NewDefinition = typeof definitions.$inferInsert;
export type WordNote = typeof wordNotes.$inferSelect;
export type NewWordNote = typeof wordNotes.$inferInsert;
export type ReviewLog = typeof reviewLog.$inferSelect;
export type NewReviewLog = typeof reviewLog.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;

// ── Usage limits / paid-feature gating (spec 13) ──────────────────────────────

/**
 * The rolling windows a usage limit can be expressed over. A closed, stable set,
 * and `feature_limits` is hand-edited via migration SQL, so it's a DB enum: a typo
 * like `hourly` fails at write time instead of silently dropping a limit.
 */
export const USAGE_WINDOWS = ["minute", "hour", "day", "month"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];
export const usageWindow = pgEnum("usage_window", USAGE_WINDOWS);

/**
 * Per-feature usage policy. One row per (slug, window); a feature may carry any
 * combination of windows (e.g. 5/min AND 120/hour). Absence of a (slug, window)
 * row = that window isn't enforced; zero rows for a slug = unlimited (fail-open).
 * The slug is a plain text column validated against the code registry
 * (`usage/features.ts`) — adding a feature must not require a DB migration.
 * Policy is adjustable directly in the DB and shipped via journaled migrations.
 */
export const featureLimits = pgTable(
  "feature_limits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    window: usageWindow("window").notNull(),
    /** Max allowed events within the trailing window. */
    maxCount: integer("max_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("feature_limits_slug_window_uniq").on(t.slug, t.window)],
);

/**
 * Append-only usage ledger: one row per consumed use of a metered feature. Windowed
 * counts (`count(*) WHERE created_at >= now() - interval 'X'`) enforce the policy, and
 * the log doubles as the future per-use billing/audit trail. Bounded by a daily prune
 * job (see `queue/boss.ts`). The (user, slug, created_at) index serves every count.
 */
export const featureUsageEvents = pgTable(
  "feature_usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feature_usage_events_user_slug_at_idx").on(t.userId, t.slug, t.createdAt)],
);

export type FeatureLimit = typeof featureLimits.$inferSelect;
export type NewFeatureLimit = typeof featureLimits.$inferInsert;
export type FeatureUsageEvent = typeof featureUsageEvents.$inferSelect;
export type NewFeatureUsageEvent = typeof featureUsageEvents.$inferInsert;
