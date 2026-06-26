import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, schema } from "../src/db/client.js";
import { processBook } from "../src/queue/processBook.js";
import { addBookFile, addWordLevel, createBook, createUser } from "./helpers/db.js";
import { makeEpub } from "./helpers/epub.js";

const { books, bookWords, userWords } = schema;

// A no-op logger satisfying the bits of FastifyBaseLogger processBook touches.
const logger = {
  info() {},
  warn() {},
  error() {},
} as unknown as FastifyBaseLogger;

let userId: string;

beforeEach(async () => {
  userId = await createUser();
  await addWordLevel("en", "fox", "A1", "cefrj");
  await addWordLevel("en", "dog", "A2", "octanove");
});

async function wordRow(bookId: string, word: string) {
  const [row] = await db
    .select()
    .from(bookWords)
    .where(and(eq(bookWords.bookId, bookId), eq(bookWords.word, word)));
  return row;
}

describe("processBook", () => {
  it("parses the EPUB, persists words, and enriches CEFR levels", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    const epub = await makeEpub(
      "<p>The fox ran. The dog and the fox played together.</p>",
    );
    await addBookFile(book.id, epub);

    await processBook(book.id, logger);

    const [updated] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updated!.status).toBe("ready");
    expect(updated!.chapterCount).toBe(1);
    expect(updated!.tokenCount).toBeGreaterThan(0);

    const fox = await wordRow(book.id, "fox");
    expect(fox).toMatchObject({ count: 2, lemma: "fox", level: "A1" });
    const dog = await wordRow(book.id, "dog");
    expect(dog!.level).toBe("A2");
  });

  it("auto-ignores a confirmed proper noun that has no vetted CEFR level", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    // "Zeus" capitalized mid-sentence ≥2 times -> core flags it `confirmed`.
    const epub = await makeEpub(
      "<p>The fox ran. I saw Zeus there. The mighty Zeus ruled. Everyone feared Zeus.</p>",
    );
    await addBookFile(book.id, epub);

    await processBook(book.id, logger);

    const zeus = await wordRow(book.id, "zeus");
    expect(zeus!.properNoun).toBe("confirmed");

    const [uw] = await db
      .select({ status: userWords.status })
      .from(userWords)
      .where(and(eq(userWords.userId, userId), eq(userWords.lemma, "zeus")));
    expect(uw?.status).toBe("ignored");

    // The common, leveled word is NOT auto-ignored.
    const [foxIgnore] = await db
      .select()
      .from(userWords)
      .where(and(eq(userWords.userId, userId), eq(userWords.lemma, "fox")));
    expect(foxIgnore).toBeUndefined();
  });

  it("marks the book failed (not crashing) when the file is not a valid EPUB", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    await addBookFile(book.id, Buffer.from("this is not a zip"));

    await processBook(book.id, logger);

    const [updated] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toBeTruthy();
  });

  it("is idempotent — re-running replaces prior words", async () => {
    const book = await createBook(userId, { status: "uploaded" });
    await addBookFile(book.id, await makeEpub("<p>The fox ran fast.</p>"));
    await processBook(book.id, logger);
    await processBook(book.id, logger);

    const foxes = await db
      .select()
      .from(bookWords)
      .where(and(eq(bookWords.bookId, book.id), eq(bookWords.word, "fox")));
    expect(foxes).toHaveLength(1); // not duplicated
  });
});
