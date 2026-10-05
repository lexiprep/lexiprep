import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { deleteBook, recordWordLookup, searchBookDictionary } from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

let userId: string;
let book: Book;

beforeEach(async () => {
  userId = await createUser();
  book = await createBook(userId, { language: "en" });
  await addBookWords(book.id, [
    { word: "stride", lemma: "stride", count: 2, level: "B2" },
    { word: "strode", lemma: "stride", count: 3, level: "B2" },
    { word: "lie", lemma: "lie", count: 4, level: "A2" },
    { word: "believe", lemma: "believe", count: 40, level: "A1" },
    { word: "relief", lemma: "relief", count: 9, level: "B1" },
    { word: "the", lemma: null, count: 99, isStopword: true },
  ]);
});

const words = (rows: { word: unknown }[]) => rows.map((r) => r.word);

describe("searchBookDictionary", () => {
  it("returns nothing for an empty query", async () => {
    expect(await searchBookDictionary(userId, book, "  ")).toEqual([]);
  });

  it("finds the base-form row by a surface form", async () => {
    const rows = await searchBookDictionary(userId, book, "strode");
    expect(rows).toEqual([
      { word: "stride", count: 5, level: "B2", example: null, status: null },
    ]);
  });

  it("puts the exact match first, then sorts by frequency", async () => {
    const rows = await searchBookDictionary(userId, book, "lie");
    expect(words(rows)).toEqual(["lie", "believe", "relief"]);
  });

  it("includes known and ignored words", async () => {
    await setUserWord(userId, "en", "lie", "known");
    await setUserWord(userId, "en", "relief", "ignored");
    const rows = await searchBookDictionary(userId, book, "lie");
    expect(rows.find((r) => r.word === "lie")?.status).toBe("known");
    expect(rows.find((r) => r.word === "relief")?.status).toBe("ignored");
  });

  it("leaves stopwords out", async () => {
    expect(await searchBookDictionary(userId, book, "the")).toEqual([]);
  });

  it("treats LIKE wildcards in the query literally", async () => {
    expect(await searchBookDictionary(userId, book, "%")).toEqual([]);
    expect(await searchBookDictionary(userId, book, "l_e")).toEqual([]);
  });
});

describe("recordWordLookup", () => {
  const lookups = () =>
    db.select().from(schema.wordLookups).where(eq(schema.wordLookups.userId, userId));

  it("appends one row per lookup, keyed by the base form", async () => {
    expect(await recordWordLookup(userId, book, "Stride")).toBe(true);
    expect(await recordWordLookup(userId, book, "stride")).toBe(true);
    const rows = await lookups();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ bookId: book.id, language: "en", lemma: "stride" });
  });

  it("refuses a word that is not in the book", async () => {
    expect(await recordWordLookup(userId, book, "zebra")).toBe(false);
    expect(await lookups()).toHaveLength(0);
  });

  it("keeps the history when the book is deleted", async () => {
    await recordWordLookup(userId, book, "lie");
    await deleteBook(userId, book.id);
    const rows = await lookups();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookId: null, lemma: "lie" });
  });
});
