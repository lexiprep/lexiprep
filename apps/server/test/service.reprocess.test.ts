import { describe, it, expect } from "vitest";
import { getBook, reprocessBook } from "../src/books/service.js";
import { createUser, createBook } from "./helpers/db.js";

describe("reprocessBook", () => {
  it("flips an owned book back to processing and clears any prior error", async () => {
    const userId = await createUser();
    const book = await createBook(userId, { status: "failed", error: "boom" });

    const updated = await reprocessBook(userId, book.id);

    expect(updated?.status).toBe("processing");
    expect(updated?.error).toBeNull();
  });

  it("returns null for another user's book and leaves its status untouched", async () => {
    const owner = await createUser({ email: "owner@example.com" });
    const other = await createUser({ email: "other@example.com" });
    const book = await createBook(owner, { status: "ready" });

    expect(await reprocessBook(other, book.id)).toBeNull();
    expect((await getBook(owner, book.id))?.status).toBe("ready");
  });
});
