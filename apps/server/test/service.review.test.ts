import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import {
  reviewBatch,
  finishBookReview,
  upsertUserWords,
  deleteUserWord,
  listUserWords,
} from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import { addBookWords, createBook, createUser, setUserWord } from "./helpers/db.js";

const { userWords, books } = schema;

let userId: string;
let book: Book;

beforeEach(async () => {
  userId = await createUser();
  book = await createBook(userId, { language: "en" });
});

async function statusOf(lemma: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: userWords.status })
    .from(userWords)
    .where(and(eq(userWords.userId, userId), eq(userWords.lemma, lemma)));
  return row?.status;
}

describe("reviewBatch", () => {
  it("flags `learning` and marks the rest `known` by default", async () => {
    const res = await reviewBatch(userId, book, ["alpha", "beta", "gamma"], ["alpha"]);
    expect(res).toEqual({ learning: 1, resolved: 2 });
    expect(await statusOf("alpha")).toBe("learning");
    expect(await statusOf("beta")).toBe("known");
    expect(await statusOf("gamma")).toBe("known");
  });

  it("can mark the rest `ignored` (junk) instead of known", async () => {
    await reviewBatch(userId, book, ["junk1", "junk2"], [], "ignored");
    expect(await statusOf("junk1")).toBe("ignored");
    expect(await statusOf("junk2")).toBe("ignored");
  });

  it("normalizes case and does not double-count the learning subset", async () => {
    const res = await reviewBatch(userId, book, ["Alpha", "BETA"], ["ALPHA"]);
    expect(await statusOf("alpha")).toBe("learning");
    expect(await statusOf("beta")).toBe("known");
    expect(res.learning).toBe(1);
  });
});

describe("finishBookReview", () => {
  it("marks every untriaged non-stopword lemma known and stamps reviewedAt", async () => {
    await addBookWords(book.id, [
      { word: "ship", lemma: "ship", count: 5 },
      { word: "ships", lemma: "ship", count: 2 },
      { word: "ocean", lemma: "ocean", count: 3 },
      { word: "the", lemma: null, count: 99, isStopword: true },
    ]);
    await setUserWord(userId, "en", "ocean", "learning"); // already triaged -> untouched

    const res = await finishBookReview(userId, book);
    expect(res.known).toBe(1); // only "ship" remained untriaged (stopword + ocean excluded)
    expect(await statusOf("ship")).toBe("known");
    expect(await statusOf("ocean")).toBe("learning"); // preserved
    expect(await statusOf("the")).toBeUndefined(); // stopword never added

    const [row] = await db
      .select({ reviewedAt: books.reviewedAt })
      .from(books)
      .where(eq(books.id, book.id));
    expect(row?.reviewedAt).toBeInstanceOf(Date);
  });
});

describe("upsertUserWords", () => {
  it("is last-write-wins on conflict", async () => {
    await upsertUserWords(userId, "en", [{ lemma: "word", status: "learning" }], "learning");
    await upsertUserWords(userId, "en", [{ lemma: "word", status: "known" }], "learning");
    expect(await statusOf("word")).toBe("known");
  });

  it("dedupes within a single batch (later entry wins)", async () => {
    await upsertUserWords(
      userId,
      "en",
      [
        { lemma: "dup", status: "learning" },
        { lemma: "dup", status: "ignored" },
      ],
      "learning",
    );
    expect(await statusOf("dup")).toBe("ignored");
  });

  it("ignores empty lemmas", async () => {
    await upsertUserWords(userId, "en", [{ lemma: "   ", status: "known" }], "learning");
    const all = await listUserWords(userId);
    expect(all).toHaveLength(0);
  });
});

describe("deleteUserWord & listUserWords", () => {
  it("removes a single word and filters the list by status/language", async () => {
    await setUserWord(userId, "en", "keep", "learning");
    await setUserWord(userId, "en", "drop", "known");
    await setUserWord(userId, "es", "hola", "learning");

    await deleteUserWord(userId, "en", "drop", "learning");

    const en = await listUserWords(userId, { language: "en" });
    expect(en.map((w) => w.lemma)).toEqual(["keep"]);

    const learning = await listUserWords(userId, { status: "learning" });
    expect(learning.map((w) => w.lemma).sort()).toEqual(["hola", "keep"]);
  });
});
