import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { db } from "../db/client.js";
import {
  books,
  bookFiles,
  bookWords,
  userWords,
  definitions,
  wordNotes,
  type Book,
  type UserWordStatus,
  type WordSense,
} from "../db/schema.js";

const FREEDICT_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const MAX_SENSES = 5;

/**
 * Coerce sense examples to plain strings. Open English WordNet sometimes stores an
 * example as an attributed quote object `{ text, source }` rather than a string, which
 * violates {@link WordSense} and crashes the React modal ("objects are not valid as a
 * React child"). Normalize on read so existing data is safe without re-importing.
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

interface FreeDictEntry {
  meanings?: {
    partOfSpeech?: string;
    definitions?: { definition?: string; example?: string }[];
  }[];
}

/**
 * Fallback for words not in the bundled dictionary: fetch from the Free Dictionary API
 * (Wiktionary, CC BY-SA) and cache the result in `definitions` (positive or empty), so
 * each missing word hits the network at most once. Returns null on transient errors
 * (not cached) so it can be retried later.
 */
async function fetchAndCacheDefinition(
  language: string,
  lemma: string,
): Promise<WordSense[] | null> {
  let senses: WordSense[];
  try {
    const res = await fetch(FREEDICT_URL + encodeURIComponent(lemma));
    if (res.status === 404) {
      senses = []; // definitively absent — cache the negative
    } else if (!res.ok) {
      return null; // transient (rate limit / outage) — don't cache, allow retry
    } else {
      const data = (await res.json()) as FreeDictEntry[];
      senses = [];
      const seen = new Set<string>();
      for (const entry of data) {
        for (const m of entry.meanings ?? []) {
          for (const d of m.definitions ?? []) {
            const gloss = d.definition?.trim();
            if (!gloss || seen.has(gloss)) continue;
            seen.add(gloss);
            senses.push({ pos: m.partOfSpeech ?? "", gloss, example: d.example });
            if (senses.length >= MAX_SENSES) break;
          }
          if (senses.length >= MAX_SENSES) break;
        }
        if (senses.length >= MAX_SENSES) break;
      }
    }
  } catch {
    return null; // network error — don't cache
  }

  await db
    .insert(definitions)
    .values({ language, lemma, senses, source: "freedict" })
    .onConflictDoNothing({ target: [definitions.language, definitions.lemma] });
  return senses;
}

export interface UploadInput {
  filename: string;
  mimeType: string | undefined;
  data: Buffer;
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.(epub|pdf)$/i, "").trim() || filename;
}

/** Persist an uploaded book + its bytes (one transaction). Status starts `uploaded`. */
export async function createBook(userId: string, input: UploadInput): Promise<Book> {
  return db.transaction(async (tx) => {
    const [book] = await tx
      .insert(books)
      .values({
        userId,
        title: titleFromFilename(input.filename),
        sourceFilename: input.filename,
        status: "uploaded",
      })
      .returning();
    if (!book) throw new Error("Failed to create book");

    await tx.insert(bookFiles).values({
      bookId: book.id,
      filename: input.filename,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.data.length,
      data: input.data,
    });
    return book;
  });
}

/**
 * Re-run extraction for an existing book with the currently installed @lexiprep/core.
 * The stored file is reused and {@link processBook} rebuilds `book_words` idempotently;
 * the user's triage (`user_words`) and notes (`word_notes`) are keyed separately and are
 * left untouched. Flips status to "processing" immediately so the UI reflects it before
 * the worker picks the job up. Returns the updated book, or null if it isn't the user's
 * (so the route can 404 without leaking existence). Enqueuing the job stays in the route.
 */
export async function reprocessBook(
  userId: string,
  bookId: string,
): Promise<Book | null> {
  const book = await getBook(userId, bookId);
  if (!book) return null;
  const [updated] = await db
    .update(books)
    .set({ status: "processing", error: null })
    .where(and(eq(books.id, bookId), eq(books.userId, userId)))
    .returning();
  return updated ?? null;
}

export interface BookListItem extends Book {
  /** Distinct words (lemmas) in the book, stopwords hidden — same as the book page's `total`. */
  uniqueWords: number;
  /** Of those, still untriaged (not yet sorted into known/learning/ignored). */
  wordsToReview: number;
}

/**
 * The user's books, newest first, each enriched with two review-progress counts:
 * `uniqueWords` (distinct lemma groups, stopwords hidden) and `wordsToReview` (those still
 * untriaged). Computed from `book_words` grouped by base form so they match
 * {@link getBookWordStats}'s `total`/`remaining` exactly. Books with no words yet count 0.
 */
export async function listBooks(userId: string): Promise<BookListItem[]> {
  const rows = await db
    .select()
    .from(books)
    .where(eq(books.userId, userId))
    .orderBy(desc(books.createdAt));

  // One row per (book, lemma-group): is it a stopword group, and has it been triaged?
  const grp = db
    .select({
      bookId: bookWords.bookId,
      isStopword: sql<boolean>`bool_or(${bookWords.isStopword})`.as("is_stopword"),
      triaged: sql<boolean>`bool_or(${userWords.id} is not null)`.as("triaged"),
    })
    .from(bookWords)
    .innerJoin(books, eq(books.id, bookWords.bookId))
    .leftJoin(
      userWords,
      and(
        eq(userWords.userId, userId),
        sql`${userWords.language} = ${books.language}`,
        sql`${userWords.lemma} = ${KEY}`,
      ),
    )
    .where(eq(books.userId, userId))
    .groupBy(bookWords.bookId, KEY)
    .as("grp");

  const counts = await db
    .select({
      bookId: grp.bookId,
      uniqueWords: sql<number>`count(*) filter (where ${grp.isStopword} = false)::int`,
      wordsToReview: sql<number>`count(*) filter (where ${grp.isStopword} = false and ${grp.triaged} = false)::int`,
    })
    .from(grp)
    .groupBy(grp.bookId);

  const byId = new Map(counts.map((c) => [c.bookId, c]));
  return rows.map((b) => ({
    ...b,
    uniqueWords: byId.get(b.id)?.uniqueWords ?? 0,
    wordsToReview: byId.get(b.id)?.wordsToReview ?? 0,
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getBook(userId: string, bookId: string): Promise<Book | null> {
  if (!UUID_RE.test(bookId)) return null; // malformed id -> not found, never a 500
  const [book] = await db
    .select()
    .from(books)
    .where(and(eq(books.id, bookId), eq(books.userId, userId)))
    .limit(1);
  return book ?? null;
}

export interface WordsQuery {
  includeStopwords?: boolean;
  /** Triage view: `all` shows everything; `known`/`learning`/`ignored` filter to that
   * status; anything else (default) shows only untriaged ("to review") words. */
  status?: string;
  /** Legacy alias for `status: "all"`. */
  includeTriaged?: boolean;
  /** Keep only words at or above this CEFR level (A1..C2); excludes unleveled. */
  minLevel?: string;
  /** Keep only words at or below this CEFR level (A1..C2); excludes unleveled. */
  maxLevel?: string;
  /** Multi-column sort, e.g. "level:desc,count:desc". Whitelisted fields only. */
  sort?: string;
  limit?: number;
  offset?: number;
}

// The grouping key: base form when lemmatized, else the surface word.
const KEY = sql`coalesce(${bookWords.lemma}, ${bookWords.word})`;

// Sortable aggregates over the lemma group. CEFR text sorts in level order
// (A1<A2<B1<B2<C1<C2), and all forms of a lemma share one level, so max() is fine.
const GROUP_SORT = {
  count: sql`sum(${bookWords.count})`,
  word: KEY,
  level: sql`max(${bookWords.level})`,
} as const;

/** Parse "field:dir,field:dir" into ORDER BY fragments over the grouped aggregates. */
function buildOrderBy(sort: string | undefined): SQL[] {
  const order: SQL[] = [];
  const used = new Set<string>();
  for (const part of (sort ?? "").split(",")) {
    const [field, dir] = part.split(":");
    if (!field || used.has(field)) continue;
    const expr = GROUP_SORT[field as keyof typeof GROUP_SORT];
    if (!expr) continue;
    used.add(field);
    order.push(sql`${expr} ${sql.raw(dir === "asc" ? "asc" : "desc")} nulls last`);
  }
  if (order.length === 0) order.push(sql`sum(${bookWords.count}) desc`);
  if (!used.has("word")) order.push(sql`${KEY} asc`);
  return order;
}

// CEFR level filtering treats unleveled words (NULL `level` — names / rare words) as a
// band that sorts below A1, selectable via the `none` sentinel. Comparing
// `coalesce(level, '')` keeps the A1..C2 text order and folds unleveled in as ''.
const UNLEVELED = "none";
function levelBound(token: string): string {
  return token === UNLEVELED ? "" : token;
}

/** Inclusive `>=`/`<=` range conditions for a level expression, unleveled-aware. */
function levelRange(level: SQLWrapper, min?: string, max?: string): SQL[] {
  const out: SQL[] = [];
  if (min) out.push(sql`coalesce(${level}, '') >= ${levelBound(min)}`);
  if (max) out.push(sql`coalesce(${level}, '') <= ${levelBound(max)}`);
  // A real CEFR ceiling means "A1..max" and must not leak unleveled words: NULL folds
  // to '' which sorts below A1, so `<= max` would keep them (unlike a real min floor,
  // which already drops them via `>=`). Unleveled is opt-in only via an explicit `none`
  // bound (min='—' opts it back in; max='—' selects unleveled exclusively).
  if (max && max !== UNLEVELED && min !== UNLEVELED) out.push(sql`${level} is not null`);
  return out;
}

// Triage view: default is untriaged-only ("to review"); `all` shows everything;
// a specific status filters to it. `userWords` is left-joined on the lemma.
type TriageView = "untriaged" | "all" | "known" | "learning" | "ignored";
function triageView(q: { status?: string; includeTriaged?: boolean }): TriageView {
  if (q.status === "known" || q.status === "learning" || q.status === "ignored") {
    return q.status;
  }
  if (q.status === "all" || q.includeTriaged) return "all";
  return "untriaged";
}
function triageCondition(view: TriageView): SQL | undefined {
  if (view === "all") return undefined;
  if (view === "untriaged") return isNull(userWords.id);
  return eq(userWords.status, view);
}

/**
 * The review queue / batch for a book, **grouped by base form (lemma)** so each row is
 * one word with its conjugations' counts summed (spec 02) — `echo/echoes/echoing`
 * collapse into one `echo`. Hides stopwords and every lemma the user has triaged by
 * default (spec 05). Supports a CEFR `minLevel` filter and multi-column `sort`. The
 * displayed `word` is the base form; `getWordDetail` lists the individual surface forms.
 */
export function getBookWords(userId: string, book: Book, q: WordsQuery) {
  const where = [eq(bookWords.bookId, book.id)];
  const triage = triageCondition(triageView(q));
  if (triage) where.push(triage);
  where.push(...levelRange(bookWords.level, q.minLevel, q.maxLevel));

  return db
    .select({
      word: KEY.as("word"),
      count: sql<number>`sum(${bookWords.count})::int`.as("count"),
      level: sql<string | null>`max(${bookWords.level})`.as("level"),
      example: sql<string | null>`max(${bookWords.example})`.as("example"),
      status: userWords.status,
    })
    .from(bookWords)
    .leftJoin(
      userWords,
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, book.language),
        sql`${userWords.lemma} = ${KEY}`,
      ),
    )
    .where(and(...where))
    .groupBy(KEY, userWords.status)
    // Hide a lemma if any of its surface forms is a function word.
    .having(q.includeStopwords ? sql`true` : sql`bool_or(${bookWords.isStopword}) = false`)
    .orderBy(...buildOrderBy(q.sort))
    .limit(Math.min(q.limit ?? 100, 1000))
    .offset(q.offset ?? 0);
}

/**
 * Headline counts for the review header: `total` distinct words (lemmas) in the book,
 * `remaining` still to review (untriaged), and `filtered` matching the current view
 * (level filter etc.). All count lemma-groups, hiding stopwords like the list.
 */
export async function getBookWordStats(userId: string, book: Book, q: WordsQuery) {
  const count = (opts: {
    view: TriageView;
    minLevel?: string;
    maxLevel?: string;
    includeStopwords?: boolean;
  }): Promise<number> => {
    const where = [eq(bookWords.bookId, book.id)];
    const triage = triageCondition(opts.view);
    if (triage) where.push(triage);
    where.push(...levelRange(bookWords.level, opts.minLevel, opts.maxLevel));
    const sub = db
      .select({ k: KEY.as("k") })
      .from(bookWords)
      .leftJoin(
        userWords,
        and(
          eq(userWords.userId, userId),
          eq(userWords.language, book.language),
          sql`${userWords.lemma} = ${KEY}`,
        ),
      )
      .where(and(...where))
      .groupBy(KEY)
      .having(opts.includeStopwords ? sql`true` : sql`bool_or(${bookWords.isStopword}) = false`)
      .as("sub");
    return db
      .select({ n: sql<number>`count(*)::int` })
      .from(sub)
      .then((r) => r[0]?.n ?? 0);
  };

  const [total, remaining, filtered, unleveled] = await Promise.all([
    count({ view: "all" }),
    count({ view: "untriaged" }),
    count({
      view: triageView(q),
      minLevel: q.minLevel,
      maxLevel: q.maxLevel,
      includeStopwords: q.includeStopwords,
    }),
    // Untriaged words with no CEFR level (names / rare words) — the "first stage" junk.
    count({ view: "untriaged", minLevel: UNLEVELED, maxLevel: UNLEVELED }),
  ]);
  return { total, remaining, filtered, unleveled };
}

// ── User vocabulary (user_words) ────────────────────────────────────────────

export interface UserWordItem {
  lemma: string;
  status: UserWordStatus;
}

export function listUserWords(
  userId: string,
  opts: { language?: string; status?: UserWordStatus } = {},
) {
  const conditions = [eq(userWords.userId, userId)];
  if (opts.language) conditions.push(eq(userWords.language, opts.language));
  if (opts.status) conditions.push(eq(userWords.status, opts.status));
  return db
    .select({
      lemma: userWords.lemma,
      language: userWords.language,
      status: userWords.status,
      updatedAt: userWords.updatedAt,
    })
    .from(userWords)
    .where(and(...conditions))
    .orderBy(asc(userWords.lemma));
}

/** Bulk upsert of (lemma -> status) for one user+language. Last write wins. */
export async function upsertUserWords(
  userId: string,
  language: string,
  items: UserWordItem[],
): Promise<void> {
  // Dedupe within the batch (later entries win) so one INSERT has no dup conflict keys.
  const byLemma = new Map<string, UserWordStatus>();
  for (const { lemma, status } of items) {
    const key = lemma.trim().toLowerCase();
    if (key) byLemma.set(key, status);
  }
  if (byLemma.size === 0) return;

  await db
    .insert(userWords)
    .values([...byLemma].map(([lemma, status]) => ({ userId, language, lemma, status })))
    .onConflictDoUpdate({
      target: [userWords.userId, userWords.language, userWords.lemma],
      set: { status: sql`excluded.status`, updatedAt: sql`now()` },
    });
}

export function deleteUserWord(userId: string, language: string, lemma: string) {
  return db
    .delete(userWords)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        eq(userWords.lemma, lemma.trim().toLowerCase()),
      ),
    );
}

// ── Book review ─────────────────────────────────────────────────────────────

/**
 * Resolve one review batch: the flagged words become `learning`, the rest of the batch
 * become `rest` (spec 05). `rest` is `known` for the normal "Mark reviewed", or
 * `ignored` for "Ignore rest" (clearing junk — names, rare words). `words` is the full
 * batch shown; `learning` is the flagged subset.
 */
export async function reviewBatch(
  userId: string,
  book: Book,
  words: string[],
  learning: string[],
  rest: "known" | "ignored" = "known",
): Promise<{ learning: number; resolved: number }> {
  const learningSet = new Set(learning.map((w) => w.trim().toLowerCase()));
  const items: UserWordItem[] = [];
  for (const lemma of learningSet) items.push({ lemma, status: "learning" });
  for (const raw of words) {
    const lemma = raw.trim().toLowerCase();
    if (lemma && !learningSet.has(lemma)) items.push({ lemma, status: rest });
  }
  await upsertUserWords(userId, book.language, items);
  return { learning: learningSet.size, resolved: items.length - learningSet.size };
}

/**
 * "Mark whole book reviewed": every still-untriaged, non-stopword word becomes
 * `known`, and the book is stamped `reviewedAt`.
 */
export async function finishBookReview(
  userId: string,
  book: Book,
): Promise<{ known: number }> {
  const remaining = await db
    .select({ key: sql<string>`coalesce(${bookWords.lemma}, ${bookWords.word})` })
    .from(bookWords)
    .leftJoin(
      userWords,
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, book.language),
        sql`${userWords.lemma} = ${KEY}`,
      ),
    )
    .where(and(eq(bookWords.bookId, book.id), isNull(userWords.id)))
    .groupBy(KEY)
    .having(sql`bool_or(${bookWords.isStopword}) = false`);

  await upsertUserWords(
    userId,
    book.language,
    remaining.map((r) => ({ lemma: r.key, status: "known" as const })),
  );
  await db.update(books).set({ reviewedAt: new Date() }).where(eq(books.id, book.id));
  return { known: remaining.length };
}

/**
 * Word detail for the modal, keyed by the base form (the list row's `word`). Lists every
 * surface form (conjugation) that appears in the text with its own count and example.
 * `definition` is fetched lazily by the enrichment layer (spec 03) — null until that lands.
 */
export async function getWordDetail(userId: string, book: Book, rawWord: string) {
  const key = rawWord.trim().toLowerCase();
  const forms = await db
    .select({
      word: bookWords.word,
      count: bookWords.count,
      level: bookWords.level,
      example: bookWords.example,
    })
    .from(bookWords)
    .where(and(eq(bookWords.bookId, book.id), sql`${KEY} = ${key}`))
    .orderBy(desc(bookWords.count));
  if (forms.length === 0) return null;

  const [uw] = await db
    .select({ status: userWords.status })
    .from(userWords)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, book.language),
        eq(userWords.lemma, key),
      ),
    )
    .limit(1);

  const [def] = await db
    .select({ senses: definitions.senses })
    .from(definitions)
    .where(and(eq(definitions.language, book.language), eq(definitions.lemma, key)))
    .limit(1);
  // Fall back to the Free Dictionary API for words the bundled dictionary lacks.
  let definition = def?.senses ?? null;
  if (definition === null && book.language === "en") {
    definition = await fetchAndCacheDefinition(book.language, key);
  }
  if (definition) definition = normalizeSenses(definition);

  const [noteRow] = await db
    .select({ note: wordNotes.note })
    .from(wordNotes)
    .where(
      and(
        eq(wordNotes.userId, userId),
        eq(wordNotes.bookId, book.id),
        eq(wordNotes.lemma, key),
      ),
    )
    .limit(1);

  return {
    word: key,
    lemma: key,
    count: forms.reduce((sum, f) => sum + f.count, 0),
    level: forms[0]!.level,
    example: forms.find((f) => f.example)?.example ?? null,
    status: uw?.status ?? null,
    forms: forms.map((f) => ({ word: f.word, count: f.count, example: f.example })),
    definition, // bundled (make dict-update) or Free Dictionary API fallback (spec 03)
    note: noteRow?.note ?? null,
  };
}

/** Add/replace the user's per-book note for a word (keyed by base form). */
export async function setWordNote(
  userId: string,
  book: Book,
  rawWord: string,
  note: string,
): Promise<void> {
  const lemma = rawWord.trim().toLowerCase();
  await db
    .insert(wordNotes)
    .values({ userId, bookId: book.id, lemma, note })
    .onConflictDoUpdate({
      target: [wordNotes.userId, wordNotes.bookId, wordNotes.lemma],
      set: { note, updatedAt: sql`now()` },
    });
}

export function deleteWordNote(userId: string, book: Book, rawWord: string) {
  return db
    .delete(wordNotes)
    .where(
      and(
        eq(wordNotes.userId, userId),
        eq(wordNotes.bookId, book.id),
        eq(wordNotes.lemma, rawWord.trim().toLowerCase()),
      ),
    );
}

// ── Learning review (cross-book) ─────────────────────────────────────────────

export interface ReviewWordsQuery {
  language?: string;
  /** Which vocabulary state to review. Defaults to `learning`. */
  status?: UserWordStatus;
  /** Restrict to words that occur in this book. */
  bookId?: string;
  /** CEFR range (inclusive); each bound is optional and excludes unleveled words. */
  minLevel?: string;
  maxLevel?: string;
  /** Case-insensitive substring match on the word. */
  q?: string;
  /** "field:dir" — field ∈ {added, word, level, count}. Defaults to `added:desc`. */
  sort?: string;
  limit?: number;
  offset?: number;
}

type ReviewAgg = ReturnType<typeof reviewBookAgg>;

/**
 * Per-lemma rollup of the user's books: total occurrences, CEFR level, an example, and
 * which book(s) the word appears in (with a representative title/id, the most frequent
 * one). Scoped to the user's own books in one language, optionally narrowed to a single
 * book. Joined to `user_words` to build the cross-book study list.
 */
function reviewBookAgg(userId: string, language: string, bookId?: string) {
  return db
    .select({
      // Aliased distinctly from user_words.lemma: Drizzle renders subquery sql-columns
      // unqualified, so a plain "lemma" would be ambiguous in the outer join condition.
      lemma: sql<string>`coalesce(${bookWords.lemma}, ${bookWords.word})`.as("agg_lemma"),
      count: sql<number>`sum(${bookWords.count})::int`.as("agg_count"),
      level: sql<string | null>`max(${bookWords.level})`.as("level"),
      example: sql<string | null>`max(${bookWords.example})`.as("example"),
      bookCount: sql<number>`count(distinct ${books.id})::int`.as("book_count"),
      bookTitle: sql<
        string | null
      >`(array_agg(${books.title} order by ${bookWords.count} desc))[1]`.as("book_title"),
      bookId: sql<
        string | null
      >`(array_agg(${books.id} order by ${bookWords.count} desc))[1]`.as("book_id"),
    })
    .from(bookWords)
    .innerJoin(books, eq(books.id, bookWords.bookId))
    .where(
      and(
        eq(books.userId, userId),
        eq(books.language, language),
        bookId ? eq(books.id, bookId) : undefined,
      ),
    )
    .groupBy(sql`coalesce(${bookWords.lemma}, ${bookWords.word})`)
    .as("book_agg");
}

/** WHERE for the review list: the user's words of one status, plus the active filters. */
function reviewWhere(agg: ReviewAgg, userId: string, q: ReviewWordsQuery): SQL[] {
  const where: SQL[] = [
    eq(userWords.userId, userId),
    eq(userWords.language, q.language ?? "en"),
    eq(userWords.status, q.status ?? "learning"),
  ];
  // Only words that still occur in at least one of the user's books (or in the filtered
  // book). A triaged word whose occurrences dropped to zero — e.g. after a reprocess split
  // or stripped it away — must not linger in the vocabulary. (`agg` has a row only when the
  // summed count is >= 1.)
  where.push(sql`${agg.lemma} is not null`);
  where.push(...levelRange(agg.level, q.minLevel, q.maxLevel));
  if (q.q) {
    where.push(sql`${userWords.lemma} like ${"%" + q.q.trim().toLowerCase() + "%"}`);
  }
  return where;
}

/** Parse "field:dir" into ORDER BY fragments; always tie-breaks on the word. */
function reviewOrderBy(sort: string | undefined, agg: ReviewAgg): SQL[] {
  const fields: Record<string, SQL> = {
    added: sql`${userWords.updatedAt}`,
    word: sql`${userWords.lemma}`,
    level: sql`${agg.level}`,
    count: sql`coalesce(${agg.count}, 0)`,
  };
  const order: SQL[] = [];
  const used = new Set<string>();
  for (const part of (sort ?? "").split(",")) {
    const [field, dir] = part.split(":");
    if (!field || used.has(field) || !fields[field]) continue;
    used.add(field);
    order.push(sql`${fields[field]} ${sql.raw(dir === "asc" ? "asc" : "desc")} nulls last`);
  }
  if (order.length === 0) order.push(sql`${userWords.updatedAt} desc`);
  if (!used.has("word")) order.push(sql`${userWords.lemma} asc`);
  return order;
}

/**
 * The cross-book study list: the user's `learning` words (by default), each enriched with
 * its CEFR level, total occurrences across the library, an example, and the book(s) it
 * appears in. Filter by book, CEFR range, and a substring; sort and paginate. Words that
 * no longer occur in any of the user's books (zero count) are excluded — a triaged word
 * whose occurrences vanished after reprocessing shouldn't linger in the vocabulary.
 */
export function listLearningWords(userId: string, q: ReviewWordsQuery) {
  const agg = reviewBookAgg(userId, q.language ?? "en", q.bookId);
  return db
    .select({
      word: userWords.lemma,
      status: userWords.status,
      updatedAt: userWords.updatedAt,
      level: agg.level,
      count: sql<number>`coalesce(${agg.count}, 0)`,
      bookCount: sql<number>`coalesce(${agg.bookCount}, 0)`,
      bookTitle: agg.bookTitle,
      bookId: agg.bookId,
      example: agg.example,
    })
    .from(userWords)
    .leftJoin(agg, sql`${agg.lemma} = ${userWords.lemma}`)
    .where(and(...reviewWhere(agg, userId, q)))
    .orderBy(...reviewOrderBy(q.sort, agg))
    .limit(Math.min(q.limit ?? 100, 1000))
    .offset(q.offset ?? 0);
}

// ── Anki export ──────────────────────────────────────────────────────────────

export interface DeckQuery {
  language?: string;
  /** Restrict to learning words that occur in these books (empty = all the user's books). */
  bookIds?: string[];
  minLevel?: string;
  maxLevel?: string;
}

export interface DeckCard {
  word: string;
  level: string | null;
  /** First-occurrence context sentence (front of the card). */
  example: string | null;
  /** Dictionary senses (back of the card); empty when none cached. */
  senses: WordSense[];
}

/**
 * Build an Anki deck from the user's **learning** words: one card per word, with its
 * context sentence (front) and cached definition (back). Optionally narrowed to a set of
 * books and a CEFR range. Definitions are read from the cache only (no per-word network
 * fetch — a 2k-word export must stay fast); words with no cached sense get an empty back.
 */
export async function buildAnkiDeck(userId: string, q: DeckQuery): Promise<DeckCard[]> {
  const language = q.language ?? "en";
  const bookIds = q.bookIds && q.bookIds.length > 0 ? q.bookIds : undefined;

  const agg = db
    .select({
      lemma: sql<string>`coalesce(${bookWords.lemma}, ${bookWords.word})`.as("agg_lemma"),
      level: sql<string | null>`max(${bookWords.level})`.as("level"),
      example: sql<string | null>`max(${bookWords.example})`.as("example"),
      count: sql<number>`sum(${bookWords.count})::int`.as("agg_count"),
    })
    .from(bookWords)
    .innerJoin(books, eq(books.id, bookWords.bookId))
    .where(
      and(
        eq(books.userId, userId),
        eq(books.language, language),
        bookIds ? inArray(books.id, bookIds) : undefined,
      ),
    )
    .groupBy(sql`coalesce(${bookWords.lemma}, ${bookWords.word})`)
    .as("book_agg");

  const where: SQL[] = [
    eq(userWords.userId, userId),
    eq(userWords.language, language),
    eq(userWords.status, "learning"),
  ];
  // Only words that occur in a book (the card front is the context sentence).
  where.push(sql`${agg.lemma} is not null`);
  where.push(...levelRange(agg.level, q.minLevel, q.maxLevel));

  const rows = await db
    .select({
      word: userWords.lemma,
      level: agg.level,
      example: agg.example,
      count: sql<number>`coalesce(${agg.count}, 0)`,
    })
    .from(userWords)
    .leftJoin(agg, sql`${agg.lemma} = ${userWords.lemma}`)
    .where(and(...where))
    .orderBy(sql`coalesce(${agg.count}, 0) desc`, asc(userWords.lemma))
    .limit(5000);

  if (rows.length === 0) return [];

  const defs = await db
    .select({ lemma: definitions.lemma, senses: definitions.senses })
    .from(definitions)
    .where(
      and(
        eq(definitions.language, language),
        inArray(
          definitions.lemma,
          rows.map((r) => r.word),
        ),
      ),
    );
  const defMap = new Map(defs.map((d) => [d.lemma, d.senses]));

  return rows.map((r) => ({
    word: r.word,
    level: r.level,
    example: r.example,
    senses: normalizeSenses(defMap.get(r.word) ?? []),
  }));
}

/** `total` = all the user's words of this status; `filtered` = those matching the view. */
export async function countLearningWords(userId: string, q: ReviewWordsQuery) {
  const language = q.language ?? "en";
  // Both counts exclude words that no longer occur in any of the user's books. `total`
  // additionally ignores the level/book/search filters — it's the per-status grand total.
  const totalAgg = reviewBookAgg(userId, language, undefined);
  const total = db
    .select({ n: sql<number>`count(*)::int` })
    .from(userWords)
    .leftJoin(totalAgg, sql`${totalAgg.lemma} = ${userWords.lemma}`)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        eq(userWords.status, q.status ?? "learning"),
        sql`${totalAgg.lemma} is not null`,
      ),
    )
    .then((r) => r[0]?.n ?? 0);

  const agg = reviewBookAgg(userId, language, q.bookId);
  const filtered = db
    .select({ n: sql<number>`count(*)::int` })
    .from(userWords)
    .leftJoin(agg, sql`${agg.lemma} = ${userWords.lemma}`)
    .where(and(...reviewWhere(agg, userId, q)))
    .then((r) => r[0]?.n ?? 0);

  const [t, f] = await Promise.all([total, filtered]);
  return { total: t, filtered: f };
}

// ── Vocabulary stats ─────────────────────────────────────────────────────────

/** A correlated EXISTS: the user_words row's lemma occurs in ≥1 of the user's books. */
function occursForUser(userId: string, language: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(bookWords)
      .innerJoin(books, eq(books.id, bookWords.bookId))
      .where(
        and(
          eq(books.userId, userId),
          eq(books.language, language),
          sql`coalesce(${bookWords.lemma}, ${bookWords.word}) = ${userWords.lemma}`,
        ),
      ),
  );
}

export interface VocabCounts {
  learning: number;
  known: number;
  ignored: number;
}

/**
 * Count the user's words per status (for the vocabulary tab badges). Excludes words that
 * no longer occur in any of the user's books — consistent with what the lists actually show.
 */
export async function countUserWordsByStatus(
  userId: string,
  language = "en",
): Promise<VocabCounts> {
  const rows = await db
    .select({ status: userWords.status, n: sql<number>`count(*)::int` })
    .from(userWords)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        occursForUser(userId, language),
      ),
    )
    .groupBy(userWords.status);

  const out: VocabCounts = { learning: 0, known: 0, ignored: 0 };
  for (const r of rows) {
    if (r.status === "learning" || r.status === "known" || r.status === "ignored") {
      out[r.status] = r.n;
    }
  }
  return out;
}

export type Granularity = "day" | "week" | "month";
export const GRANULARITIES: readonly Granularity[] = ["day", "week", "month"];

export interface TimeseriesPoint {
  /** Bucket start, YYYY-MM-DD. */
  period: string;
  learning: number;
  known: number;
}

export interface VocabularyTimeseries {
  granularity: Granularity;
  /** Words already accumulated before `from` (so cumulative totals start from the truth). */
  baseline: { learning: number; known: number };
  /** Words *added* (first triaged) per bucket, by current status. */
  buckets: TimeseriesPoint[];
}

export interface TimeseriesQuery {
  language?: string;
  from: Date;
  /** Inclusive end day. */
  to: Date;
  granularity: Granularity;
}

/**
 * Vocabulary growth over time. Each word is bucketed by when it was first added
 * (`created_at`) and attributed to its current status — so the series reads as "how my
 * Learning / Known vocabulary accumulated". Only words that still occur in a book are
 * counted (matching the lists). NOTE: status history isn't stored, so a word that moved
 * learning → known shows only under Known, at its add date. `baseline` carries the totals
 * before `from` so a cumulative chart starts from the real running total, not zero.
 */
export async function getVocabularyTimeseries(
  userId: string,
  q: TimeseriesQuery,
): Promise<VocabularyTimeseries> {
  const language = q.language ?? "en";
  const toExclusive = new Date(q.to.getTime() + 24 * 60 * 60 * 1000); // include the `to` day
  const occ = occursForUser(userId, language);
  // Inline the (allowlisted) granularity as a literal, not a bind param: the same
  // date_trunc expression must appear in SELECT, GROUP BY and ORDER BY, and Postgres
  // only treats them as one grouped expression when they're textually identical.
  const unit: Granularity = GRANULARITIES.includes(q.granularity) ? q.granularity : "day";
  const trunc = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${userWords.createdAt})`;

  const bucketRows = await db
    .select({
      period: sql<string>`to_char(${trunc}, 'YYYY-MM-DD')`,
      status: userWords.status,
      n: sql<number>`count(*)::int`,
    })
    .from(userWords)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        inArray(userWords.status, ["learning", "known"]),
        gte(userWords.createdAt, q.from),
        lt(userWords.createdAt, toExclusive),
        occ,
      ),
    )
    .groupBy(trunc, userWords.status)
    .orderBy(trunc);

  const baselineRows = await db
    .select({ status: userWords.status, n: sql<number>`count(*)::int` })
    .from(userWords)
    .where(
      and(
        eq(userWords.userId, userId),
        eq(userWords.language, language),
        inArray(userWords.status, ["learning", "known"]),
        lt(userWords.createdAt, q.from),
        occ,
      ),
    )
    .groupBy(userWords.status);

  const byPeriod = new Map<string, TimeseriesPoint>();
  for (const r of bucketRows) {
    const p = byPeriod.get(r.period) ?? { period: r.period, learning: 0, known: 0 };
    if (r.status === "learning" || r.status === "known") p[r.status] = r.n;
    byPeriod.set(r.period, p);
  }
  const baseline = { learning: 0, known: 0 };
  for (const r of baselineRows) {
    if (r.status === "learning" || r.status === "known") baseline[r.status] = r.n;
  }

  return {
    granularity: q.granularity,
    baseline,
    buckets: [...byPeriod.values()],
  };
}
