import { describe, it, expect, beforeEach } from "vitest";
import {
  listLearningWords,
  countLearningWords,
  buildAnkiDeck,
} from "../src/books/service.js";
import {
  addBookWords,
  addDefinition,
  createBook,
  createUser,
  setUserWord,
} from "./helpers/db.js";

let userId: string;
let book1Id: string;
let book2Id: string;

beforeEach(async () => {
  userId = await createUser();
  const b1 = await createBook(userId, { title: "Sea Tales", language: "en" });
  const b2 = await createBook(userId, { title: "More Sea", language: "en" });
  book1Id = b1.id;
  book2Id = b2.id;

  await addBookWords(book1Id, [
    { word: "ocean", lemma: "ocean", count: 5, level: "B1", example: "the deep ocean" },
    { word: "suitor", lemma: "suitor", count: 2, level: "C1" },
  ]);
  await addBookWords(book2Id, [
    { word: "ocean", lemma: "ocean", count: 3, level: "B1" },
    { word: "tide", lemma: "tide", count: 1, level: "B2" },
  ]);

  for (const w of ["ocean", "suitor", "tide", "abyss"]) {
    await setUserWord(userId, "en", w, "learning");
  }
  // "abyss" is a manually added word — present in no book.
});

describe("listLearningWords", () => {
  it("rolls a word up across books: summed count, distinct book count, level", async () => {
    const rows = await listLearningWords(userId, {});
    const ocean = rows.find((r) => r.word === "ocean");
    expect(ocean).toMatchObject({ count: 8, bookCount: 2, level: "B1" });
    expect(ocean!.example).toBe("the deep ocean");
  });

  it("picks the most-frequent book as the representative", async () => {
    const ocean = (await listLearningWords(userId, {})).find((r) => r.word === "ocean");
    expect(ocean!.bookTitle).toBe("Sea Tales"); // 5 > 3
    expect(ocean!.bookId).toBe(book1Id);
  });

  it("excludes words that no longer occur in any book (zero count)", async () => {
    // "abyss" is triaged but present in no book — it must not appear in the vocabulary.
    const abyss = (await listLearningWords(userId, {})).find((r) => r.word === "abyss");
    expect(abyss).toBeUndefined();
  });

  it("filters to a single book, dropping words not in it", async () => {
    const rows = await listLearningWords(userId, { bookId: book2Id });
    const words = rows.map((r) => r.word).sort();
    expect(words).toEqual(["ocean", "tide"]); // no suitor (book1 only), no abyss (no book)
  });

  it("filters by CEFR range, excluding unleveled words", async () => {
    const words = (await listLearningWords(userId, { minLevel: "B2" })).map((r) => r.word).sort();
    expect(words).toEqual(["suitor", "tide"]); // ocean B1 below, abyss unleveled excluded
  });

  it("filters by substring on the word", async () => {
    const words = (await listLearningWords(userId, { q: "ti" })).map((r) => r.word);
    expect(words).toEqual(["tide"]);
  });

  it("sorts by count descending when asked", async () => {
    const counts = (await listLearningWords(userId, { sort: "count:desc" })).map((r) => r.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("filters by the library-wide occurrence count", async () => {
    // ocean 8 (5+3), tide 1, suitor 2.
    const atLeast3 = (await listLearningWords(userId, { minCount: 3 })).map((r) => r.word);
    expect(atLeast3).toEqual(["ocean"]);
    const upTo2 = (await listLearningWords(userId, { maxCount: 2 })).map((r) => r.word).sort();
    expect(upTo2).toEqual(["suitor", "tide"]);
    const band = (await listLearningWords(userId, { minCount: 2, maxCount: 8 }))
      .map((r) => r.word)
      .sort();
    expect(band).toEqual(["ocean", "suitor"]);
  });

  it("keeps the count filter library-wide even when one book is in view", async () => {
    // "ocean" occurs 3× in book2 but 8× across the library — a floor of 5 keeps it, and
    // the displayed `count` stays the in-view number while `totalCount` is the library's.
    const rows = await listLearningWords(userId, { bookId: book2Id, minCount: 5 });
    expect(rows.map((r) => r.word)).toEqual(["ocean"]);
    expect(rows[0]).toMatchObject({ count: 3, totalCount: 8, bookCount: 2 });
    // The same floor read book-locally (3 < 5) would have dropped it.
    const strict = await listLearningWords(userId, { bookId: book2Id, minCount: 9 });
    expect(strict).toEqual([]);
  });

  it("sorts by how many books a word spans", async () => {
    const rows = await listLearningWords(userId, { sort: "books:desc" });
    expect(rows[0]!.word).toBe("ocean"); // the only word in two books
    expect(rows[0]!.bookCount).toBe(2);
  });

  it("only returns words of the requested status", async () => {
    await addBookWords(book1Id, [{ word: "reef", lemma: "reef", count: 1, level: "B2" }]);
    await setUserWord(userId, "en", "reef", "known");
    const rows = await listLearningWords(userId, { status: "known" });
    expect(rows.map((r) => r.word)).toEqual(["reef"]);
  });
});

describe("countLearningWords", () => {
  it("reports total of the status and the filtered subset", async () => {
    const stats = await countLearningWords(userId, { minLevel: "B2" });
    expect(stats.total).toBe(3); // ocean, suitor, tide (abyss excluded — in no book)
    expect(stats.filtered).toBe(2); // suitor + tide
  });

  it("counts the count-filtered subset, library-wide, under a book filter", async () => {
    const stats = await countLearningWords(userId, { bookId: book2Id, minCount: 5 });
    expect(stats.total).toBe(3); // unchanged by the filters
    expect(stats.filtered).toBe(1); // ocean: 3× in this book, 8× across the library
  });
});

describe("buildAnkiDeck", () => {
  it("builds one card per learning word with example and cached senses", async () => {
    await addDefinition("en", "ocean", [{ pos: "noun", gloss: "a large body of salt water" }]);
    const deck = await buildAnkiDeck(userId, {});
    const ocean = deck.find((c) => c.word === "ocean");
    expect(ocean).toMatchObject({
      level: "B1",
      example: "the deep ocean",
      senses: [{ pos: "noun", gloss: "a large body of salt water" }],
    });
    // A word with no cached definition still gets a card with empty senses.
    expect(deck.find((c) => c.word === "tide")?.senses).toEqual([]);
  });

  it("restricts to the requested books", async () => {
    const deck = await buildAnkiDeck(userId, { bookIds: [book2Id] });
    expect(deck.map((c) => c.word).sort()).toEqual(["ocean", "tide"]);
  });

  it("restricts to a CEFR range", async () => {
    const deck = await buildAnkiDeck(userId, { minLevel: "C1" });
    expect(deck.map((c) => c.word)).toEqual(["suitor"]);
  });
});
