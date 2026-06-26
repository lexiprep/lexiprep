import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import {
  getWordDetail,
  setWordNote,
  deleteWordNote,
} from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import {
  addBookWords,
  addDefinition,
  createBook,
  createUser,
  setUserWord,
} from "./helpers/db.js";

const { definitions, wordNotes } = schema;

let userId: string;
let book: Book;

beforeEach(async () => {
  userId = await createUser();
  book = await createBook(userId, { language: "en" });
});

describe("getWordDetail", () => {
  beforeEach(async () => {
    await addBookWords(book.id, [
      { word: "says", lemma: "say", count: 3, level: "A1", example: "He says hi." },
      { word: "said", lemma: "say", count: 5, level: "A1", example: "She said bye." },
    ]);
  });

  it("aggregates forms, count, level, example and lists surface forms by frequency", async () => {
    const d = await getWordDetail(userId, book, "say");
    expect(d).not.toBeNull();
    expect(d!.word).toBe("say");
    expect(d!.count).toBe(8);
    expect(d!.level).toBe("A1");
    expect(d!.example).toBe("She said bye."); // first form (highest count) with an example
    expect(d!.forms.map((f) => f.word)).toEqual(["said", "says"]);
  });

  it("attaches the user's status and a per-book note", async () => {
    await setUserWord(userId, "en", "say", "learning");
    await setWordNote(userId, book, "say", "verb of speech");
    const d = await getWordDetail(userId, book, "say");
    expect(d!.status).toBe("learning");
    expect(d!.note).toBe("verb of speech");
  });

  it("includes the bundled definition when present", async () => {
    await addDefinition("en", "say", [{ pos: "verb", gloss: "to utter words" }]);
    const d = await getWordDetail(userId, book, "say");
    expect(d!.definition).toEqual([{ pos: "verb", gloss: "to utter words" }]);
  });

  it("normalizes a legacy attributed-quote example object into a plain string", async () => {
    // Open English WordNet sometimes stored { text, source }; normalize on read.
    await db.insert(definitions).values({
      language: "en",
      lemma: "say",
      source: "wordnet",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      senses: [{ pos: "verb", gloss: "g", example: { text: "quoted", source: "x" } }] as any,
    });
    const d = await getWordDetail(userId, book, "say");
    expect(d!.definition).toEqual([{ pos: "verb", gloss: "g", example: "quoted" }]);
  });

  it("returns null for a word not in the book", async () => {
    expect(await getWordDetail(userId, book, "nope")).toBeNull();
  });
});

describe("getWordDetail — Free Dictionary fallback", () => {
  beforeEach(async () => {
    await addBookWords(book.id, [{ word: "obscure", lemma: "obscure", count: 1 }]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches & caches a definition for words missing from the bundled dictionary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { meanings: [{ partOfSpeech: "adj", definitions: [{ definition: "not clear" }] }] },
        ]),
        { status: 200 },
      ),
    );

    const d = await getWordDetail(userId, book, "obscure");
    expect(d!.definition).toEqual([{ pos: "adj", gloss: "not clear" }]);

    // It was cached (source freedict) so a second lookup hits no network.
    const [cached] = await db
      .select()
      .from(definitions)
      .where(and(eq(definitions.lemma, "obscure"), eq(definitions.source, "freedict")));
    expect(cached).toBeTruthy();

    fetchMock.mockClear();
    await getWordDetail(userId, book, "obscure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches a negative (empty) result on a 404 so the word is fetched at most once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));

    const d = await getWordDetail(userId, book, "obscure");
    expect(d!.definition).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const again = await getWordDetail(userId, book, "obscure");
    expect(again!.definition).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache on a transient error (allows a later retry)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const d = await getWordDetail(userId, book, "obscure");
    expect(d!.definition).toBeNull();
    const rows = await db
      .select()
      .from(definitions)
      .where(eq(definitions.lemma, "obscure"));
    expect(rows).toHaveLength(0);
  });
});

describe("setWordNote / deleteWordNote", () => {
  beforeEach(async () => {
    await addBookWords(book.id, [{ word: "ship", lemma: "ship", count: 1 }]);
  });

  it("inserts then overwrites the note (upsert)", async () => {
    await setWordNote(userId, book, "ship", "first");
    await setWordNote(userId, book, "ship", "second");
    const [row] = await db
      .select({ note: wordNotes.note })
      .from(wordNotes)
      .where(and(eq(wordNotes.userId, userId), eq(wordNotes.lemma, "ship")));
    expect(row?.note).toBe("second");
  });

  it("deletes the note", async () => {
    await setWordNote(userId, book, "ship", "note");
    await deleteWordNote(userId, book, "ship");
    expect((await getWordDetail(userId, book, "ship"))!.note).toBeNull();
  });
});
