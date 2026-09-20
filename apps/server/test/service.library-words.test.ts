import { describe, it, expect, beforeEach } from "vitest";
import { getLibraryWords, getLibraryWordStats } from "../src/books/service.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

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
    { word: "oceans", lemma: "ocean", count: 2, level: "B1" },
    { word: "suitor", lemma: "suitor", count: 2, level: "C1" },
    { word: "the", lemma: "the", count: 400, isStopword: true },
  ]);
  await addBookWords(book2Id, [
    { word: "ocean", lemma: "ocean", count: 3, level: "B1" },
    { word: "tide", lemma: "tide", count: 9, level: "B2" },
  ]);
});

describe("getLibraryWords", () => {
  it("sums a word across books and its own conjugations", async () => {
    const rows = await getLibraryWords(userId, {});
    const ocean = rows.find((r) => r.word === "ocean");
    expect(ocean).toMatchObject({ count: 10, bookCount: 2, level: "B1" });
  });

  it("names the book a word occurs in most as the representative", async () => {
    const ocean = (await getLibraryWords(userId, {})).find((r) => r.word === "ocean");
    expect(ocean!.bookTitle).toBe("Sea Tales"); // 5 + 2 > 3
    expect(ocean!.bookId).toBe(book1Id);
  });

  it("hides stopwords and, by default, every word already triaged", async () => {
    await setUserWord(userId, "en", "tide", "known");
    const words = (await getLibraryWords(userId, {})).map((r) => r.word);
    expect(words).toEqual(["ocean", "suitor"]); // no "the" (stopword), no "tide" (triaged)
  });

  it("shows one triage status at a time when asked", async () => {
    await setUserWord(userId, "en", "tide", "known");
    const known = await getLibraryWords(userId, { status: "known" });
    expect(known.map((r) => r.word)).toEqual(["tide"]);
    expect(known[0]).toMatchObject({ status: "known", count: 9 });
    const all = await getLibraryWords(userId, { status: "all" });
    expect(all.map((r) => r.word).sort()).toEqual(["ocean", "suitor", "tide"]);
  });

  it("sorts by total count, and by how many books a word spans", async () => {
    const byCount = (await getLibraryWords(userId, { sort: "count:desc" })).map((r) => r.word);
    expect(byCount).toEqual(["ocean", "tide", "suitor"]); // 10, 9, 2

    const byBooks = await getLibraryWords(userId, { sort: "books:desc" });
    expect(byBooks[0]!.word).toBe("ocean"); // the only word in two books
  });

  it("filters by CEFR range and by substring, like a book's list", async () => {
    const leveled = (await getLibraryWords(userId, { minLevel: "B2" })).map((r) => r.word);
    expect(leveled.sort()).toEqual(["suitor", "tide"]);
    const searched = (await getLibraryWords(userId, { q: "ti" })).map((r) => r.word);
    expect(searched).toEqual(["tide"]);
  });

  it("ignores other users' books and other languages", async () => {
    const other = await createUser();
    const theirs = await createBook(other, { title: "Not Yours", language: "en" });
    await addBookWords(theirs.id, [{ word: "kraken", count: 99 }]);
    const spanish = await createBook(userId, { title: "El Mar", language: "es" });
    await addBookWords(spanish.id, [{ word: "marea", count: 40 }]);

    const words = (await getLibraryWords(userId, {})).map((r) => r.word);
    expect(words).not.toContain("kraken");
    expect(words).not.toContain("marea");
  });

  it("pages over the grouped rows", async () => {
    const page = await getLibraryWords(userId, { sort: "count:desc", limit: 1, offset: 1 });
    expect(page.map((r) => r.word)).toEqual(["tide"]);
  });
});

describe("getLibraryWordStats", () => {
  it("counts a word once however many books it spans", async () => {
    const stats = await getLibraryWordStats(userId, {});
    // ocean (2 books) + suitor + tide = 3 distinct words; "the" is a stopword.
    expect(stats).toMatchObject({ total: 3, remaining: 3, filtered: 3 });
  });

  it("drops triaged words from `remaining` but not from `total`", async () => {
    await setUserWord(userId, "en", "ocean", "known");
    const stats = await getLibraryWordStats(userId, {});
    expect(stats.total).toBe(3);
    expect(stats.remaining).toBe(2);
  });

  it("reports the filtered subset for the current view", async () => {
    const stats = await getLibraryWordStats(userId, { minLevel: "B2" });
    expect(stats).toMatchObject({ total: 3, remaining: 3, filtered: 2 });
  });
});
