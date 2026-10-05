import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { loadBookFile, setObjectStoreForTests } from "../src/storage/bookFiles.js";
import { copyBookFilesToBucket, pruneBookFileBytes } from "../src/storage/migrateBookFiles.js";
import { addBookFile, createBook, createUser } from "./helpers/db.js";
import { MemoryObjectStore } from "./helpers/objectStore.js";

const { bookFiles } = schema;
const A = Buffer.from("PK first book bytes");
const B = Buffer.from("%PDF- second book bytes");

let store: MemoryObjectStore;
let a: string;
let b: string;
const row = async (bookId: string) =>
  (await db.select().from(bookFiles).where(eq(bookFiles.bookId, bookId)))[0]!;

/** Two books already copied to the bucket (phase 2), bytes still in Postgres. */
beforeEach(async () => {
  const userId = await createUser();
  a = (await createBook(userId)).id;
  b = (await createBook(userId)).id;
  await addBookFile(a, A, "first.epub");
  await addBookFile(b, B, "second.pdf");
  store = new MemoryObjectStore();
  setObjectStoreForTests(store);
  await copyBookFilesToBucket();
});
afterEach(() => setObjectStoreForTests(undefined));

describe("pruneBookFileBytes", () => {
  it("clears the Postgres bytes of verified files, which then read from the bucket", async () => {
    const result = await pruneBookFileBytes();
    expect(result.failed).toEqual([]);
    expect(result.cleared).toEqual(
      expect.arrayContaining([
        { bookId: a, bytes: A.length },
        { bookId: b, bytes: B.length },
      ]),
    );
    expect(await row(a)).toMatchObject({ data: null, objectKey: `books/${a}.epub` });
    expect((await loadBookFile(a))?.data).toEqual(A);
    expect((await loadBookFile(b))?.data).toEqual(B);
  });

  it("clears nothing on a dry run", async () => {
    const result = await pruneBookFileBytes({ dryRun: true });
    expect(result.cleared).toHaveLength(2);
    expect((await row(a)).data).not.toBeNull();
  });

  it("keeps a file whose object has gone missing", async () => {
    store.objects.delete(`books/${a}.epub`);
    const result = await pruneBookFileBytes();
    expect(result.failed.map((f) => f.bookId)).toEqual([a]);
    expect(result.cleared.map((c) => c.bookId)).toEqual([b]);
    expect(Buffer.from((await row(a)).data!)).toEqual(A);
  });

  it("keeps a file whose object no longer matches", async () => {
    store.objects.set(`books/${a}.epub`, Buffer.from("PK first book bytez"));
    const result = await pruneBookFileBytes();
    expect(result.failed[0]).toMatchObject({ bookId: a });
    expect((await row(a)).data).not.toBeNull();
  });

  it("keeps a file when the bucket cannot be read", async () => {
    store.failNext = "get";
    const result = await pruneBookFileBytes();
    expect(result.failed).toHaveLength(1);
    expect(result.cleared).toHaveLength(1);
  });

  it("never touches a file that was not copied to the bucket", async () => {
    const userId = await createUser();
    const c = (await createBook(userId)).id;
    await addBookFile(c, A, "third.epub");
    await pruneBookFileBytes();
    expect(Buffer.from((await row(c)).data!)).toEqual(A);
  });

  it("can be limited to one book, and is a no-op the second time", async () => {
    expect((await pruneBookFileBytes({ bookId: a })).cleared).toEqual([
      { bookId: a, bytes: A.length },
    ]);
    expect((await row(b)).data).not.toBeNull();
    expect((await pruneBookFileBytes({ bookId: a })).cleared).toEqual([]);
  });

  it("refuses to run without object storage", async () => {
    setObjectStoreForTests(null);
    await expect(pruneBookFileBytes()).rejects.toThrow("not configured");
    expect((await row(a)).data).not.toBeNull();
  });
});
