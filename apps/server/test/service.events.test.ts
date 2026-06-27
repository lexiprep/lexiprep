import { describe, it, expect, beforeEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import {
  upsertUserWords,
  deleteUserWord,
  reviewBatch,
  getVocabularyTimeseries,
} from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

const { userWordEvents } = schema;

let userId: string;
let book: Book;

beforeEach(async () => {
  userId = await createUser();
  book = await createBook(userId, { language: "en" });
});

/** Events for one lemma, oldest first, projected to the fields we assert on. */
async function eventsFor(lemma: string) {
  return db
    .select({
      from: userWordEvents.fromStatus,
      to: userWordEvents.toStatus,
      source: userWordEvents.source,
    })
    .from(userWordEvents)
    .where(and(eq(userWordEvents.userId, userId), eq(userWordEvents.lemma, lemma)))
    .orderBy(asc(userWordEvents.at));
}

const allEvents = () =>
  db.select().from(userWordEvents).where(eq(userWordEvents.userId, userId));

/** Insert a transition event with an explicit timestamp (the write path stamps now()). */
async function addEventAt(
  lemma: string,
  from: string | null,
  to: string | null,
  source: "book" | "learning",
  isoDay: string,
) {
  const at = new Date(`${isoDay}T12:00:00.000Z`);
  await db
    .insert(userWordEvents)
    .values({ userId, language: "en", lemma, fromStatus: from, toStatus: to, source, at });
}

describe("upsertUserWords event logging", () => {
  it("records each transition with its from→to and source", async () => {
    await upsertUserWords(userId, "en", [{ lemma: "ocean", status: "learning" }], "book");
    await upsertUserWords(userId, "en", [{ lemma: "ocean", status: "known" }], "learning");

    expect(await eventsFor("ocean")).toEqual([
      { from: null, to: "learning", source: "book" }, // first triage — no prior status
      { from: "learning", to: "known", source: "learning" }, // the deliberate "learned" move
    ]);
  });

  it("does not log a no-op re-mark (same status)", async () => {
    await upsertUserWords(userId, "en", [{ lemma: "ocean", status: "learning" }], "book");
    await upsertUserWords(userId, "en", [{ lemma: "ocean", status: "learning" }], "book");
    expect(await eventsFor("ocean")).toEqual([{ from: null, to: "learning", source: "book" }]);
  });

  it("logs one event per word that actually changed in a batch", async () => {
    await setUserWord(userId, "en", "alpha", "learning");
    await upsertUserWords(
      userId,
      "en",
      [
        { lemma: "alpha", status: "learning" }, // unchanged — no event
        { lemma: "beta", status: "known" }, // new — event
      ],
      "learning",
    );
    expect(await allEvents()).toHaveLength(1);
    expect(await eventsFor("beta")).toEqual([{ from: null, to: "known", source: "learning" }]);
  });
});

describe("deleteUserWord event logging", () => {
  it("logs a clear event (to=null) carrying the prior status and source", async () => {
    await setUserWord(userId, "en", "ocean", "known");
    await deleteUserWord(userId, "en", "ocean", "book");
    expect(await eventsFor("ocean")).toEqual([{ from: "known", to: null, source: "book" }]);
  });

  it("logs nothing when the word had no row", async () => {
    await deleteUserWord(userId, "en", "ghost", "learning");
    expect(await allEvents()).toHaveLength(0);
  });
});

describe("reviewBatch attributes events to the book page", () => {
  it("tags every transition source 'book' (triage, never a 'learned' word)", async () => {
    await reviewBatch(userId, book, ["alpha", "beta"], ["alpha"]); // alpha->learning, beta->known
    const events = await allEvents();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.source === "book")).toBe(true);
  });
});

describe("getVocabularyTimeseries — learned series", () => {
  beforeEach(async () => {
    // Every lemma below except "notinbook" occurs in a book (the series is occurrence-filtered).
    await addBookWords(book.id, [
      { word: "learn1", lemma: "learn1", count: 3 },
      { word: "learn2", lemma: "learn2", count: 2 },
      { word: "before", lemma: "before", count: 2 },
      { word: "bookcorr", lemma: "bookcorr", count: 1 },
    ]);
    await addEventAt("before", "learning", "known", "learning", "2026-01-05"); // pre-range -> baseline
    await addEventAt("learn1", null, "learning", "book", "2026-01-01"); // to=learning -> not learned
    await addEventAt("learn1", "learning", "known", "learning", "2026-01-12"); // learned
    await addEventAt("learn2", "learning", "known", "learning", "2026-02-05"); // learned
    await addEventAt("bookcorr", "learning", "known", "book", "2026-01-12"); // book source -> excluded
    await addEventAt("notinbook", "learning", "known", "learning", "2026-01-12"); // no book -> excluded
  });

  it("counts only learning→known transitions made from the Learning page", async () => {
    const ts = await getVocabularyTimeseries(userId, {
      from: new Date("2026-01-11T00:00:00Z"),
      to: new Date("2026-02-28T00:00:00Z"),
      granularity: "day",
    });
    expect(ts.baseline.learned).toBe(1); // "before" (learned Jan 5, pre-range)
    const learnedByPeriod = Object.fromEntries(ts.buckets.map((b) => [b.period, b.learned]));
    expect(learnedByPeriod["2026-01-12"]).toBe(1); // learn1 only (bookcorr + notinbook excluded)
    expect(learnedByPeriod["2026-02-05"]).toBe(1); // learn2
  });

  it("excludes book-page learning→known done through the real write path", async () => {
    // A word taken learning → known entirely on the book page is a correction, not learned.
    await upsertUserWords(userId, "en", [{ lemma: "learn1", status: "learning" }], "book");
    await upsertUserWords(userId, "en", [{ lemma: "learn1", status: "known" }], "book");

    const ts = await getVocabularyTimeseries(userId, {
      from: new Date("2000-01-01T00:00:00Z"),
      to: new Date("2999-12-31T00:00:00Z"),
      granularity: "month",
    });
    const learnedTotal = ts.baseline.learned + ts.buckets.reduce((s, b) => s + b.learned, 0);
    // Only the three Learning-page transitions from the seed count; the book-page pair doesn't.
    expect(learnedTotal).toBe(3);
  });
});
