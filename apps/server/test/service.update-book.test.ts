import { describe, it, expect } from "vitest";
import { getBook, updateBook } from "../src/books/service.js";
import { createUser, createBook } from "./helpers/db.js";

describe("updateBook", () => {
  it("updates title / author / translator and trims them", async () => {
    const userId = await createUser();
    const book = await createBook(userId, { title: "Old", author: "A", translator: null });

    const updated = await updateBook(userId, book.id, {
      title: "  New Title  ",
      author: "  Jane Doe  ",
      translator: "  John Smith  ",
    });

    expect(updated?.title).toBe("New Title");
    expect(updated?.author).toBe("Jane Doe");
    expect(updated?.translator).toBe("John Smith");
  });

  it("only touches provided fields", async () => {
    const userId = await createUser();
    const book = await createBook(userId, { title: "Keep", author: "Stay" });

    const updated = await updateBook(userId, book.id, { translator: "T" });

    expect(updated?.title).toBe("Keep");
    expect(updated?.author).toBe("Stay");
    expect(updated?.translator).toBe("T");
  });

  it("clears author / translator when given an empty string", async () => {
    const userId = await createUser();
    const book = await createBook(userId, { author: "A", translator: "B" });

    const updated = await updateBook(userId, book.id, { author: "  ", translator: "" });

    expect(updated?.author).toBeNull();
    expect(updated?.translator).toBeNull();
  });

  it("rejects an empty title (NOT NULL column)", async () => {
    const userId = await createUser();
    const book = await createBook(userId, { title: "Original" });

    await expect(updateBook(userId, book.id, { title: "   " })).rejects.toThrow();
    expect((await getBook(userId, book.id))?.title).toBe("Original");
  });

  it("returns null for another user's book and leaves it untouched", async () => {
    const owner = await createUser({ email: "owner@example.com" });
    const other = await createUser({ email: "other@example.com" });
    const book = await createBook(owner, { title: "Owned" });

    expect(await updateBook(other, book.id, { title: "Hacked" })).toBeNull();
    expect((await getBook(owner, book.id))?.title).toBe("Owned");
  });
});
