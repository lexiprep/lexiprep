import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema } from "../../src/db/client.js";
import type { UserWordStatus, WordSense } from "../../src/db/schema.js";

const { user, books, bookWords, bookFiles, userWords, wordLevels, definitions, wordNotes } =
  schema;

// Child-first so CASCADE has nothing to complain about; covers every app + auth table.
const TABLES = [
  "word_notes",
  "user_word_events",
  "user_words",
  "book_words",
  "book_files",
  "definitions",
  "word_levels",
  "books",
  "session",
  "account",
  "verification",
  '"user"',
];

/** Empty every table — called before each test for isolation. */
export async function resetDb(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

/** Insert a minimal user row and return its id. */
export async function createUser(
  over: { id?: string; name?: string; email?: string } = {},
): Promise<string> {
  const id = over.id ?? `user_${randomUUID()}`;
  await db.insert(user).values({
    id,
    name: over.name ?? "Test User",
    email: over.email ?? `${id}@example.com`,
  });
  return id;
}

type BookOverrides = Partial<typeof books.$inferInsert>;

export async function createBook(userId: string, over: BookOverrides = {}) {
  const [book] = await db
    .insert(books)
    .values({
      userId,
      title: over.title ?? "A Book",
      language: over.language ?? "en",
      status: over.status ?? "ready",
      ...over,
    })
    .returning();
  return book!;
}

export interface SeedWord {
  word: string;
  lemma?: string | null;
  count?: number;
  level?: string | null;
  example?: string | null;
  isStopword?: boolean;
  properNoun?: string | null;
}

/** Bulk-insert book_words for a book, defaulting count=1, isStopword=false. */
export async function addBookWords(bookId: string, rows: SeedWord[]): Promise<void> {
  await db.insert(bookWords).values(
    rows.map((r) => ({
      bookId,
      word: r.word,
      lemma: r.lemma ?? null,
      count: r.count ?? 1,
      level: r.level ?? null,
      example: r.example ?? null,
      isStopword: r.isStopword ?? false,
      properNoun: r.properNoun ?? null,
    })),
  );
}

export async function addWordLevel(
  language: string,
  lemma: string,
  level: string,
  source = "cefrj",
): Promise<void> {
  await db.insert(wordLevels).values({ language, lemma, level, source });
}

export async function addDefinition(
  language: string,
  lemma: string,
  senses: WordSense[],
  source = "wordnet",
): Promise<void> {
  await db.insert(definitions).values({ language, lemma, senses, source });
}

export async function setUserWord(
  userId: string,
  language: string,
  lemma: string,
  status: UserWordStatus,
  over: Partial<typeof userWords.$inferInsert> = {},
): Promise<void> {
  await db.insert(userWords).values({ userId, language, lemma, status, ...over });
}

export async function addBookFile(
  bookId: string,
  data: Buffer,
  filename = "book.epub",
): Promise<void> {
  await db.insert(bookFiles).values({
    bookId,
    filename,
    mimeType: "application/epub+zip",
    sizeBytes: data.length,
    data,
  });
}
