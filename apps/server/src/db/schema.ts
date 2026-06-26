import {
  pgTable,
  uuid,
  text,
  integer,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("user_words_user_lang_lemma_uniq").on(t.userId, t.language, t.lemma)],
);

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
