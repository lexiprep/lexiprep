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

  it("includes manually-added words (no book) with zero count and null level", async () => {
    const abyss = (await listLearningWords(userId, {})).find((r) => r.word === "abyss");
    expect(abyss).toMatchObject({ count: 0, bookCount: 0, level: null });
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

  it("only returns words of the requested status", async () => {
    await setUserWord(userId, "en", "known-word", "known");
    const rows = await listLearningWords(userId, { status: "known" });
    expect(rows.map((r) => r.word)).toEqual(["known-word"]);
  });
});

describe("countLearningWords", () => {
  it("reports total of the status and the filtered subset", async () => {
    const stats = await countLearningWords(userId, { minLevel: "B2" });
    expect(stats.total).toBe(4); // ocean, suitor, tide, abyss
    expect(stats.filtered).toBe(2); // suitor + tide
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
