import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db/client.js";
import { userWords } from "../src/db/schema.js";
import {
  countUserWordsByStatus,
  getVocabularyTimeseries,
} from "../src/books/service.js";
import { addBookWords, createBook, createUser } from "./helpers/db.js";

let userId: string;

/** Insert a user_word with an explicit createdAt (the helper can't set it). */
async function addWordAt(lemma: string, status: string, isoDay: string) {
  const at = new Date(`${isoDay}T12:00:00.000Z`);
  await db
    .insert(userWords)
    .values({ userId, language: "en", lemma, status, createdAt: at, updatedAt: at });
}

beforeEach(async () => {
  userId = await createUser();
  const book = await createBook(userId, { language: "en" });
  // Every lemma below except "zeta" occurs in a book.
  await addBookWords(book.id, [
    { word: "alpha", lemma: "alpha", count: 3 },
    { word: "beta", lemma: "beta", count: 2 },
    { word: "gamma", lemma: "gamma", count: 1 },
    { word: "delta", lemma: "delta", count: 1 },
  ]);
  await addWordAt("alpha", "known", "2026-01-10");
  await addWordAt("beta", "known", "2026-01-12");
  await addWordAt("gamma", "learning", "2026-01-12");
  await addWordAt("delta", "learning", "2026-02-05");
  await addWordAt("zeta", "known", "2026-01-12"); // in NO book -> excluded everywhere
});

describe("countUserWordsByStatus", () => {
  it("counts per status, excluding words not in any book", async () => {
    const counts = await countUserWordsByStatus(userId, "en");
    expect(counts).toEqual({ learning: 2, known: 2, ignored: 0 }); // zeta (known) excluded
  });
});

describe("getVocabularyTimeseries", () => {
  it("buckets adds by day with a baseline of earlier words", async () => {
    const ts = await getVocabularyTimeseries(userId, {
      from: new Date("2026-01-11T00:00:00Z"),
      to: new Date("2026-02-28T00:00:00Z"),
      granularity: "day",
    });
    // alpha (known, Jan 10) is before the range -> baseline.
    expect(ts.baseline).toEqual({ learning: 0, known: 1 });
    expect(ts.buckets).toEqual([
      { period: "2026-01-12", learning: 1, known: 1 }, // gamma + beta (zeta excluded)
      { period: "2026-02-05", learning: 1, known: 0 }, // delta
    ]);
  });

  it("groups by month", async () => {
    const ts = await getVocabularyTimeseries(userId, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-02-28T00:00:00Z"),
      granularity: "month",
    });
    expect(ts.baseline).toEqual({ learning: 0, known: 0 });
    expect(ts.buckets).toEqual([
      { period: "2026-01-01", learning: 1, known: 2 }, // gamma | alpha + beta
      { period: "2026-02-01", learning: 1, known: 0 }, // delta
    ]);
  });

  it("excludes words that occur in no book", async () => {
    const ts = await getVocabularyTimeseries(userId, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
      granularity: "day",
    });
    const totalKnown =
      ts.baseline.known + ts.buckets.reduce((s, b) => s + b.known, 0);
    expect(totalKnown).toBe(2); // alpha + beta only; zeta excluded
  });
});
