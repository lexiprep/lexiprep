import { describe, it, expect, beforeEach } from "vitest";
import { getBookWords, getBookWordStats } from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

let userId: string;
let book: Book;

/**
 * A small book covering every wrinkle of the grouped review query:
 *  - say/said   -> lemma "say"  (A1), summed count 8
 *  - run/running-> lemma "run"  (A2), summed count 6
 *  - suitor     -> lemma "suitor" (C1)
 *  - the        -> stopword (hidden by default)
 *  - zeus       -> no lemma, no level (unleveled)
 */
beforeEach(async () => {
  userId = await createUser();
  book = await createBook(userId, { language: "en" });
  await addBookWords(book.id, [
    { word: "says", lemma: "say", count: 3, level: "A1" },
    { word: "said", lemma: "say", count: 5, level: "A1" },
    { word: "run", lemma: "run", count: 2, level: "A2" },
    { word: "running", lemma: "run", count: 4, level: "A2" },
    { word: "suitor", lemma: "suitor", count: 1, level: "C1" },
    { word: "the", lemma: null, count: 99, isStopword: true },
    { word: "zeus", lemma: null, count: 7, level: null },
  ]);
});

describe("getBookWords — grouping & stopwords", () => {
  it("groups conjugations under their lemma and sums counts", async () => {
    const rows = await getBookWords(userId, book, {});
    const say = rows.find((r) => r.word === "say");
    const run = rows.find((r) => r.word === "run");
    expect(say).toMatchObject({ count: 8, level: "A1" });
    expect(run).toMatchObject({ count: 6, level: "A2" });
  });

  it("hides stopwords by default but includes them on request", async () => {
    const def = await getBookWords(userId, book, {});
    expect(def.map((r) => r.word)).not.toContain("the");

    const withStop = await getBookWords(userId, book, { includeStopwords: true });
    expect(withStop.map((r) => r.word)).toContain("the");
  });
});

describe("getBookWords — triage views", () => {
  it("excludes triaged words from the default (to-review) list", async () => {
    await setUserWord(userId, "en", "say", "known");
    const rows = await getBookWords(userId, book, {});
    expect(rows.map((r) => r.word)).not.toContain("say");
  });

  it("`all` shows every word with its status attached", async () => {
    await setUserWord(userId, "en", "say", "learning");
    const rows = await getBookWords(userId, book, { status: "all" });
    expect(rows.find((r) => r.word === "say")?.status).toBe("learning");
  });

  it("a specific status filters to only that status", async () => {
    await setUserWord(userId, "en", "say", "known");
    await setUserWord(userId, "en", "run", "learning");
    const known = await getBookWords(userId, book, { status: "known" });
    expect(known.map((r) => r.word)).toEqual(["say"]);
  });

  it("includeTriaged is a legacy alias for `all`", async () => {
    await setUserWord(userId, "en", "say", "known");
    const rows = await getBookWords(userId, book, { includeTriaged: true });
    expect(rows.map((r) => r.word)).toContain("say");
  });
});

describe("getBookWords — level filtering", () => {
  it("minLevel keeps words at or above the level (excludes unleveled)", async () => {
    const rows = await getBookWords(userId, book, { minLevel: "A2" });
    const words = rows.map((r) => r.word);
    expect(words).toEqual(expect.arrayContaining(["run", "suitor"]));
    expect(words).not.toContain("say"); // A1 is below A2
    expect(words).not.toContain("zeus"); // unleveled excluded by a bound
  });

  it("maxLevel keeps words at or below the level (excludes unleveled)", async () => {
    const words = (await getBookWords(userId, book, { maxLevel: "A2" })).map((r) => r.word);
    expect(words).toEqual(expect.arrayContaining(["say", "run"]));
    expect(words).not.toContain("suitor"); // C1 above A2
    // A CEFR ceiling must not leak unleveled words — NULL folds to '' which sorts below
    // A1, so `<= A2` would otherwise keep them. Unleveled is opt-in via `none` only.
    expect(words).not.toContain("zeus");
  });

  it("a `none` floor opts unleveled back in under a CEFR ceiling", async () => {
    const words = (
      await getBookWords(userId, book, { minLevel: "none", maxLevel: "A2" })
    ).map((r) => r.word);
    expect(words).toEqual(expect.arrayContaining(["zeus", "say", "run"]));
    expect(words).not.toContain("suitor"); // C1 above A2
  });

  it("selects unleveled words via the `none` sentinel", async () => {
    const words = (
      await getBookWords(userId, book, { minLevel: "none", maxLevel: "none" })
    ).map((r) => r.word);
    expect(words).toEqual(["zeus"]);
  });
});

describe("getBookWords — sorting & pagination", () => {
  it("defaults to most-frequent first", async () => {
    const rows = await getBookWords(userId, book, {});
    expect(rows[0]?.word).toBe("say"); // count 8 is the highest non-stopword
  });

  it("sorts by count ascending when asked", async () => {
    const counts = (await getBookWords(userId, book, { sort: "count:asc" })).map(
      (r) => r.count,
    );
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("sorts by level descending", async () => {
    const rows = await getBookWords(userId, book, { sort: "level:desc", includeStopwords: true });
    const leveled = rows.filter((r) => r.level).map((r) => r.level);
    // First leveled row is the highest band present (C1).
    expect(leveled[0]).toBe("C1");
  });

  it("honors limit and offset over the grouped rows", async () => {
    const page1 = await getBookWords(userId, book, { sort: "count:desc", limit: 2, offset: 0 });
    const page2 = await getBookWords(userId, book, { sort: "count:desc", limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page1.map((r) => r.word)).not.toEqual(page2.map((r) => r.word));
  });
});

describe("getBookWordStats", () => {
  it("reports total, remaining, filtered and unleveled lemma counts", async () => {
    // Non-stopword lemmas: say, run, suitor, zeus = 4.
    const stats = await getBookWordStats(userId, book, {});
    expect(stats.total).toBe(4);
    expect(stats.remaining).toBe(4);
    expect(stats.filtered).toBe(4);
    expect(stats.unleveled).toBe(1); // zeus
  });

  it("remaining drops as words are triaged; filtered tracks the active view", async () => {
    await setUserWord(userId, "en", "say", "known");
    const stats = await getBookWordStats(userId, book, { minLevel: "A2" });
    expect(stats.remaining).toBe(3); // say is triaged
    expect(stats.filtered).toBe(2); // run + suitor (A2 and up, untriaged)
  });
});
