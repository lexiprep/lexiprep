import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import {
  completeDirectUpload,
  createBook,
  createDirectUpload,
  deleteBook,
} from "../src/books/service.js";
import {
  loadBookFile,
  setObjectStoreForTests,
  sha256Hex,
} from "../src/storage/bookFiles.js";
import { addBookFile, createBook as seedBook, createUser } from "./helpers/db.js";
import { MemoryObjectStore } from "./helpers/objectStore.js";

const { books, bookFiles } = schema;
const BYTES = Buffer.from("PK\u0003\u0004 not really an epub, but bytes all the same");
const upload = { filename: "Odyssey.EPUB", mimeType: "application/epub+zip", data: BYTES };

let userId: string;
const fileRow = async (bookId: string) =>
  (await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)))[0];

beforeEach(async () => {
  userId = await createUser();
});
afterEach(() => setObjectStoreForTests(undefined));

describe("book files without object storage", () => {
  beforeEach(() => setObjectStoreForTests(null));

  it("keeps the bytes in Postgres, as before", async () => {
    const book = await createBook(userId, upload);
    const row = await fileRow(book.id);
    expect(row).toMatchObject({ objectKey: null, sha256: sha256Hex(BYTES), sizeBytes: BYTES.length });
    expect(Buffer.from(row!.data!)).toEqual(BYTES);
    expect((await loadBookFile(book.id))?.data).toEqual(BYTES);
  });

  it("does not offer a direct upload", async () => {
    expect(
      await createDirectUpload(userId, { filename: "big.pdf", mimeType: undefined, sizeBytes: 9 }),
    ).toBeNull();
  });
});

describe("book files in object storage", () => {
  let store: MemoryObjectStore;
  beforeEach(() => {
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
  });

  it("puts an upload in the bucket and stores only the reference", async () => {
    const book = await createBook(userId, upload);
    const row = await fileRow(book.id);
    expect(row).toMatchObject({
      data: null,
      objectKey: `books/${book.id}.epub`,
      sha256: sha256Hex(BYTES),
      sizeBytes: BYTES.length,
    });
    expect(store.objects.get(`books/${book.id}.epub`)).toEqual(BYTES);
    expect(await loadBookFile(book.id)).toMatchObject({ data: BYTES, filename: "Odyssey.EPUB" });
  });

  it("fails the upload when the bucket does, leaving nothing behind", async () => {
    store.failNext = "put";
    await expect(createBook(userId, upload)).rejects.toThrow("bucket put failed");
    expect(await db.select().from(books)).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it("removes the object when its book is deleted", async () => {
    const book = await createBook(userId, upload);
    expect(await deleteBook(userId, book.id)).toBe(true);
    expect(store.objects.size).toBe(0);
  });

  it("still deletes the book when removing the object fails", async () => {
    const book = await createBook(userId, upload);
    store.failNext = "delete";
    expect(await deleteBook(userId, book.id)).toBe(true);
    expect(await db.select().from(books)).toHaveLength(0);
  });

  it("leaves another user's book and object alone", async () => {
    const book = await createBook(userId, upload);
    expect(await deleteBook(await createUser(), book.id)).toBe(false);
    expect(store.objects.size).toBe(1);
  });

  it("still reads a book whose bytes are only in Postgres", async () => {
    const old = await seedBook(userId);
    await addBookFile(old.id, BYTES);
    expect((await loadBookFile(old.id))?.data).toEqual(BYTES);
  });

  it("falls back to the Postgres bytes when the bucket read fails", async () => {
    const book = await seedBook(userId);
    await addBookFile(book.id, BYTES);
    await db.update(bookFiles).set({ objectKey: "books/x.epub" }).where(eq(bookFiles.bookId, book.id));
    store.objects.set("books/x.epub", BYTES);
    store.failNext = "get";
    expect((await loadBookFile(book.id))?.data).toEqual(BYTES);
  });

  it("returns null when the object is gone and Postgres has no bytes", async () => {
    const book = await createBook(userId, upload);
    store.objects.clear();
    expect(await loadBookFile(book.id)).toBeNull();
  });
});

describe("direct upload", () => {
  let store: MemoryObjectStore;
  const big = { filename: "Atlas.pdf", mimeType: "application/pdf", sizeBytes: 5 };
  beforeEach(() => {
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
  });

  it("reserves the book, then confirms it against what is really in the bucket", async () => {
    const started = (await createDirectUpload(userId, big))!;
    expect(started.book).toMatchObject({ status: "uploading", title: "Atlas" });
    expect(started.uploadUrl).toContain(`books/${started.book.id}.pdf`);

    store.objects.set(`books/${started.book.id}.pdf`, Buffer.from("%PDF-1.7 seven"));
    const done = await completeDirectUpload(userId, started.book.id, 1000);
    expect(done).toMatchObject({ ok: true, book: { status: "uploaded" } });
    // Size comes from the bucket, not from what the browser claimed.
    expect((await fileRow(started.book.id))?.sizeBytes).toBe(14);

    // The worker's first read records the checksum.
    await loadBookFile(started.book.id);
    expect((await fileRow(started.book.id))?.sha256).toBe(sha256Hex(Buffer.from("%PDF-1.7 seven")));
  });

  it("refuses to complete when the file never arrived", async () => {
    const started = (await createDirectUpload(userId, big))!;
    expect(await completeDirectUpload(userId, started.book.id, 1000)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect((await db.select().from(books))[0]?.status).toBe("uploading");
  });

  it("removes an object over the cap together with its book", async () => {
    const started = (await createDirectUpload(userId, big))!;
    store.objects.set(`books/${started.book.id}.pdf`, Buffer.alloc(2000));
    expect(await completeDirectUpload(userId, started.book.id, 1000)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(await db.select().from(books)).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it("cannot be completed twice, or by another user", async () => {
    const started = (await createDirectUpload(userId, big))!;
    store.objects.set(`books/${started.book.id}.pdf`, Buffer.from("%PDF-"));
    expect(await completeDirectUpload(await createUser(), started.book.id, 1000)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect((await completeDirectUpload(userId, started.book.id, 1000)).ok).toBe(true);
    expect(await completeDirectUpload(userId, started.book.id, 1000)).toEqual({
      ok: false,
      reason: "not_uploading",
    });
  });
});
