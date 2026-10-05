import { describe, it, expect, beforeEach } from "vitest";
import { db, schema } from "../src/db/client.js";
import { countLookups, deleteBook, listLookups } from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

let userId: string;
let odyssey: Book;
let iliad: Book;

/** Log `times` lookups of a word from a book, the last one at `at`. */
async function look(book: Book, lemma: string, times: number, at: string) {
  await db.insert(schema.wordLookups).values(
    Array.from({ length: times }, () => ({
      userId,
      bookId: book.id,
      language: "en",
      lemma,
      at: new Date(at),
    })),
  );
}

beforeEach(async () => {
  userId = await createUser();
  odyssey = await createBook(userId, { title: "Odyssey" });
  iliad = await createBook(userId, { title: "Iliad" });
  await addBookWords(odyssey.id, [
    { word: "stride", lemma: "stride", count: 2, level: "B2" },
    { word: "strode", lemma: "stride", count: 3, level: "B2" },
    { word: "suitor", lemma: "suitor", count: 30, level: "C1" },
  ]);
  await addBookWords(iliad.id, [
    { word: "stride", lemma: "stride", count: 10, level: "B2" },
    { word: "wrath", lemma: "wrath", count: 7, level: "C1" },
  ]);
  await look(odyssey, "stride", 2, "2026-10-01T10:00:00Z");
  await look(iliad, "stride", 1, "2026-10-03T10:00:00Z");
  await look(odyssey, "suitor", 1, "2026-10-02T10:00:00Z");
  await look(iliad, "wrath", 2, "2026-09-20T10:00:00Z");
});

const words = (rows: { word: string }[]) => rows.map((r) => r.word);

describe("listLookups", () => {
  it("rolls the log up per word, most looked-up first, with library-wide counts", async () => {
    const rows = await listLookups(userId, {});
    expect(words(rows)).toEqual(["stride", "wrath", "suitor"]);
    expect(rows[0]).toMatchObject({
      word: "stride",
      lookups: 3,
      lastAt: "2026-10-03T10:00:00Z",
      count: 15,
      bookCount: 2,
      level: "B2",
      bookId: iliad.id,
      status: null,
    });
  });

  it("scopes lookups and counts to one book", async () => {
    const rows = await listLookups(userId, { bookId: odyssey.id });
    expect(words(rows)).toEqual(["stride", "suitor"]);
    expect(rows[0]).toMatchObject({ lookups: 2, count: 5, bookCount: 1, bookId: odyssey.id });
  });

  it("sorts by last looked up, frequency and word", async () => {
    expect(words(await listLookups(userId, { sort: "last:desc" }))).toEqual([
      "stride",
      "suitor",
      "wrath",
    ]);
    expect(words(await listLookups(userId, { sort: "count:desc" }))).toEqual([
      "suitor",
      "stride",
      "wrath",
    ]);
    expect(words(await listLookups(userId, { sort: "word:desc" }))).toEqual([
      "wrath",
      "suitor",
      "stride",
    ]);
  });

  it("filters by status, including words never triaged", async () => {
    await setUserWord(userId, "en", "stride", "known");
    await setUserWord(userId, "en", "wrath", "learning");
    expect(words(await listLookups(userId, { status: "known" }))).toEqual(["stride"]);
    expect(words(await listLookups(userId, { status: "new" }))).toEqual(["suitor"]);
    const all = await listLookups(userId, {});
    expect(all.find((r) => r.word === "wrath")?.status).toBe("learning");
  });

  it("searches the base form", async () => {
    expect(words(await listLookups(userId, { q: "ui" }))).toEqual(["suitor"]);
  });

  it("keeps a word whose only book was deleted, without a book to open", async () => {
    await deleteBook(userId, iliad.id);
    const rows = await listLookups(userId, {});
    expect(rows.find((r) => r.word === "wrath")).toMatchObject({
      lookups: 2,
      count: 0,
      bookCount: 0,
      level: null,
      bookId: null,
    });
  });

  it("never shows another user's lookups", async () => {
    const other = await createUser();
    expect(await listLookups(other, {})).toEqual([]);
  });
});

describe("countLookups", () => {
  it("totals words and lookups for the same scope and filters", async () => {
    expect(await countLookups(userId, {})).toEqual({ words: 3, lookups: 6 });
    expect(await countLookups(userId, { bookId: odyssey.id })).toEqual({ words: 2, lookups: 3 });
    expect(await countLookups(userId, { q: "zzz" })).toEqual({ words: 0, lookups: 0 });
  });
});
