import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { deleteBook, getBook, listUserWords } from "../src/books/service.js";
import {
  addBookFile,
  addBookWords,
  createBook,
  createUser,
  setUserWord,
} from "./helpers/db.js";

describe("deleteBook", () => {
  it("removes a queued book together with its file and words", async () => {
    const userId = await createUser();
    // The case this exists for: a book stuck at `uploaded` because its job never ran.
    const book = await createBook(userId, { status: "uploaded" });
    await addBookFile(book.id, Buffer.from("epub bytes"));
    await addBookWords(book.id, [{ word: "boundary" }]);

    expect(await deleteBook(userId, book.id)).toBe(true);

    expect(await getBook(userId, book.id)).toBeNull();
    expect(
      await db.select().from(schema.bookFiles).where(eq(schema.bookFiles.bookId, book.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.bookWords).where(eq(schema.bookWords.bookId, book.id)),
    ).toHaveLength(0);
  });

  it("keeps the user's cross-book vocabulary", async () => {
    const userId = await createUser();
    const book = await createBook(userId);
    await setUserWord(userId, "en", "boundary", "learning");

    expect(await deleteBook(userId, book.id)).toBe(true);
    expect(await listUserWords(userId, { language: "en" })).toHaveLength(1);
  });

  it("refuses another user's book and leaves it in place", async () => {
    const owner = await createUser({ email: "owner@example.com" });
    const other = await createUser({ email: "other@example.com" });
    const book = await createBook(owner);

    expect(await deleteBook(other, book.id)).toBe(false);
    expect(await getBook(owner, book.id)).not.toBeNull();
  });

  it("returns false for a non-uuid id", async () => {
    const userId = await createUser();
    expect(await deleteBook(userId, "not-a-uuid")).toBe(false);
  });
});
