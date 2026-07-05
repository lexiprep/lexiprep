import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import {
  addWordNote,
  deleteWordNote,
  getWordDetail,
  updateWordNote,
} from "../src/books/service.js";
import type { Book } from "../src/db/schema.js";
import {
  addBookWords,
  addDefinition,
  createBook,
  createUser,
  setUserWord,
} from "./helpers/db.js";

const { wordSenses, definitionFetches, wordNotes } = schema;

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

  it("attaches the user's status and per-book definitions", async () => {
    await setUserWord(userId, "en", "say", "learning");
    await addWordNote(userId, book, "say", "verb of speech");
    const d = await getWordDetail(userId, book, "say");
    expect(d!.status).toBe("learning");
    expect(d!.notes.map((n) => n.note)).toEqual(["verb of speech"]);
  });

  it("includes the bundled definition when present", async () => {
    await addDefinition("en", "say", [{ pos: "verb", gloss: "to utter words" }]);
    const d = await getWordDetail(userId, book, "say");
    expect(d!.definition).toEqual([{ pos: "verb", gloss: "to utter words" }]);
  });

  it("keeps sense order and includes examples", async () => {
    await addDefinition("en", "say", [
      { pos: "verb", gloss: "to utter words", example: "He said hello." },
      { pos: "noun", gloss: "the right to influence a decision" },
    ]);
    const d = await getWordDetail(userId, book, "say");
    expect(d!.definition).toEqual([
      { pos: "verb", gloss: "to utter words", example: "He said hello." },
      { pos: "noun", gloss: "the right to influence a decision" },
    ]);
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

    // It was cached (word_senses rows, source freedict) so a second lookup hits no network.
    const [cached] = await db
      .select()
      .from(wordSenses)
      .where(and(eq(wordSenses.lemma, "obscure"), eq(wordSenses.source, "freedict")));
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

    // The definitive "not found" is recorded as a fetch marker (no sense rows exist).
    const markers = await db
      .select()
      .from(definitionFetches)
      .where(eq(definitionFetches.lemma, "obscure"));
    expect(markers).toHaveLength(1);

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
      .from(wordSenses)
      .where(eq(wordSenses.lemma, "obscure"));
    expect(rows).toHaveLength(0);
    const markers = await db
      .select()
      .from(definitionFetches)
      .where(eq(definitionFetches.lemma, "obscure"));
    expect(markers).toHaveLength(0);
  });
});

describe("addWordNote / updateWordNote / deleteWordNote", () => {
  beforeEach(async () => {
    await addBookWords(book.id, [{ word: "ship", lemma: "ship", count: 1 }]);
  });

  it("allows several definitions per word and returns them in creation order", async () => {
    await addWordNote(userId, book, "ship", "first");
    await addWordNote(userId, book, "ship", "second");
    const d = await getWordDetail(userId, book, "ship");
    expect(d!.notes.map((n) => n.note)).toEqual(["first", "second"]);
  });

  it("edits one definition by id, leaving the others alone", async () => {
    const a = await addWordNote(userId, book, "ship", "first");
    await addWordNote(userId, book, "ship", "second");
    expect(await updateWordNote(userId, book, a.id, "revised")).toBe(true);
    const d = await getWordDetail(userId, book, "ship");
    expect(d!.notes.map((n) => n.note)).toEqual(["revised", "second"]);
  });

  it("refuses to edit a note that isn't the user's (tenant isolation)", async () => {
    const a = await addWordNote(userId, book, "ship", "mine");
    const other = await createUser();
    const otherBook = await createBook(other, { language: "en" });
    expect(await updateWordNote(other, otherBook, a.id, "hijack")).toBe(false);
    const d = await getWordDetail(userId, book, "ship");
    expect(d!.notes[0]!.note).toBe("mine");
  });

  it("deletes one definition by id", async () => {
    const a = await addWordNote(userId, book, "ship", "gone");
    const b = await addWordNote(userId, book, "ship", "stays");
    await deleteWordNote(userId, book, a.id);
    const rows = await db
      .select({ note: wordNotes.note })
      .from(wordNotes)
      .where(and(eq(wordNotes.userId, userId), eq(wordNotes.lemma, "ship")));
    expect(rows.map((r) => r.note)).toEqual(["stays"]);
    expect(b.note).toBe("stays");
  });
});
