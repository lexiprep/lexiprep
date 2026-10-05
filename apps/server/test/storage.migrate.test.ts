import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { createBook as uploadBook } from "../src/books/service.js";
import { loadBookFile, setObjectStoreForTests, sha256Hex } from "../src/storage/bookFiles.js";
import { copyBookFilesToBucket } from "../src/storage/migrateBookFiles.js";
import { addBookFile, createBook, createUser } from "./helpers/db.js";
import { MemoryObjectStore } from "./helpers/objectStore.js";

const { bookFiles } = schema;
const A = Buffer.from("PK first book bytes");
const B = Buffer.from("%PDF- second book bytes");

let userId: string;
let store: MemoryObjectStore;
let a: string;
let b: string;
const row = async (bookId: string) =>
  (await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)))[0]!;

/** Two books whose bytes are only in Postgres, as every book is before phase 2. */
beforeEach(async () => {
  userId = await createUser();
  a = (await createBook(userId)).id;
  b = (await createBook(userId)).id;
  await addBookFile(a, A, "first.epub");
  await addBookFile(b, B, "second.pdf");
  store = new MemoryObjectStore();
  setObjectStoreForTests(store);
});
afterEach(() => setObjectStoreForTests(undefined));

describe("copyBookFilesToBucket", () => {
  it("copies each file, records it, and leaves the Postgres bytes in place", async () => {
    const result = await copyBookFilesToBucket();
    expect(result.copied.sort()).toEqual([a, b].sort());
    expect(result.failed).toEqual([]);

    expect(store.objects.get(`books/${a}.epub`)).toEqual(A);
    expect(store.objects.get(`books/${b}.pdf`)).toEqual(B);
    const ra = await row(a);
    expect(ra).toMatchObject({ objectKey: `books/${a}.epub`, sha256: sha256Hex(A) });
    expect(Buffer.from(ra.data!)).toEqual(A);
    expect((await loadBookFile(a))?.data).toEqual(A);
  });

  it("returns a manifest of every object the database points at", async () => {
    const already = await uploadBook(userId, { filename: "new.epub", mimeType: undefined, data: A });
    const { manifest } = await copyBookFilesToBucket();
    expect(manifest).toHaveLength(3);
    expect(manifest).toContainEqual({
      bookId: b,
      objectKey: `books/${b}.pdf`,
      sizeBytes: B.length,
      sha256: sha256Hex(B),
    });
    expect(manifest.map((m) => m.bookId)).toContain(already.id);
  });

  it("skips what is already copied on a second run", async () => {
    await copyBookFilesToBucket();
    const again = await copyBookFilesToBucket();
    expect(again.copied).toEqual([]);
    expect(again.manifest).toHaveLength(2);
  });

  it("changes nothing on a dry run", async () => {
    const result = await copyBookFilesToBucket({ dryRun: true });
    expect(result.copied).toHaveLength(2);
    expect(store.objects.size).toBe(0);
    expect((await row(a)).objectKey).toBeNull();
  });

  it("can be limited to one book", async () => {
    const result = await copyBookFilesToBucket({ bookId: a });
    expect(result.copied).toEqual([a]);
    expect((await row(b)).objectKey).toBeNull();
  });

  it("does not record a copy that reads back differently", async () => {
    const put = store.put.bind(store);
    store.put = async (key, data) => put(key, key.includes(a) ? Buffer.from("corrupted") : data);
    const result = await copyBookFilesToBucket();
    expect(result.failed.map((f) => f.bookId)).toEqual([a]);
    expect(result.copied).toEqual([b]);
    expect((await row(a)).objectKey).toBeNull();
    // A later run, with the bucket behaving, finishes the job.
    store.put = put;
    expect((await copyBookFilesToBucket()).copied).toEqual([a]);
    expect(store.objects.get(`books/${a}.epub`)).toEqual(A);
  });

  it("carries on past a file whose upload fails", async () => {
    store.failNext = "put";
    const result = await copyBookFilesToBucket();
    expect(result.failed).toHaveLength(1);
    expect(result.copied).toHaveLength(1);
  });

  it("refuses to run without object storage", async () => {
    setObjectStoreForTests(null);
    await expect(copyBookFilesToBucket()).rejects.toThrow("not configured");
  });
});
