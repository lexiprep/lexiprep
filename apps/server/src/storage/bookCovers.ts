import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { bookCovers, bookFiles, books } from "../db/schema.js";
import { env } from "../env.js";
import { extractEpubCover, type CoverImage } from "../books/cover.js";
import { deleteBookObject, getObjectStore, loadBookFile, sha256Hex } from "./bookFiles.js";

type Log = { warn: (obj: object, msg: string) => void };

/** `<prefix>/covers/<bookId>.<ext>` — beside the book files, under its own folder. */
export function coverKeyFor(bookId: string, ext: string): string {
  const prefix = env.BOOKS_R2_PREFIX.replace(/^\/+|\/+$/g, "");
  return `${prefix}/covers/${bookId}.${ext}`;
}

/**
 * Record the outcome of a cover search: store the image (bucket when configured, else
 * Postgres) or, for `null`, clear any earlier one. Either way the book is stamped as
 * checked. A failed bucket upload throws and leaves the book unchecked, so the next
 * backfill run tries again.
 */
export async function saveBookCover(bookId: string, cover: CoverImage | null): Promise<void> {
  const [prev] = await db
    .select({ objectKey: bookCovers.objectKey })
    .from(bookCovers)
    .where(eq(bookCovers.bookId, bookId))
    .limit(1);

  if (!cover) {
    await db.transaction(async (tx) => {
      await tx.delete(bookCovers).where(eq(bookCovers.bookId, bookId));
      await tx
        .update(books)
        .set({ coverVersion: null, coverCheckedAt: new Date() })
        .where(eq(books.id, bookId));
    });
    await deleteBookObject(prev?.objectKey);
    return;
  }

  const sha256 = sha256Hex(cover.data);
  const store = await getObjectStore();
  const objectKey = store ? coverKeyFor(bookId, cover.ext) : null;
  if (store && objectKey) await store.put(objectKey, cover.data, cover.mimeType);

  const row = {
    mimeType: cover.mimeType,
    sizeBytes: cover.data.length,
    data: objectKey ? null : cover.data,
    objectKey,
    sha256,
  };
  let saved = false;
  await db.transaction(async (tx) => {
    // The book may have been deleted while its file was being read.
    const stamped = await tx
      .update(books)
      .set({ coverVersion: sha256.slice(0, 12), coverCheckedAt: new Date() })
      .where(eq(books.id, bookId))
      .returning({ id: books.id });
    if (stamped.length === 0) return;
    await tx
      .insert(bookCovers)
      .values({ bookId, ...row })
      .onConflictDoUpdate({ target: bookCovers.bookId, set: row });
    saved = true;
  });
  if (!saved) return deleteBookObject(objectKey);
  // A re-extracted cover of another type lands on a new key; drop the old object.
  if (prev?.objectKey && prev.objectKey !== objectKey) await deleteBookObject(prev.objectKey);
}

/** Find the cover inside a book file and store it. A PDF isn't a zip, so it yields none. */
export async function extractAndSaveCover(bookId: string, file: Uint8Array): Promise<boolean> {
  const cover = await extractEpubCover(file);
  await saveBookCover(bookId, cover);
  return cover !== null;
}

/** A book's cover bytes, or null when it has none (or the bucket can't produce them). */
export async function loadBookCover(
  bookId: string,
  log?: Log,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const [row] = await db
    .select({
      mimeType: bookCovers.mimeType,
      data: bookCovers.data,
      objectKey: bookCovers.objectKey,
    })
    .from(bookCovers)
    .where(eq(bookCovers.bookId, bookId))
    .limit(1);
  if (!row) return null;
  // pglite hands back a plain Uint8Array; normalize so callers always get a Buffer.
  if (row.data) return { data: Buffer.from(row.data), mimeType: row.mimeType };
  if (!row.objectKey) return null;
  try {
    const data = await (await getObjectStore())?.get(row.objectKey);
    return data ? { data, mimeType: row.mimeType } : null;
  } catch (err) {
    log?.warn({ err, bookId, objectKey: row.objectKey }, "book cover: bucket read failed");
    return null;
  }
}

export interface BackfillResult {
  found: string[];
  none: string[];
  failed: string[];
}

/**
 * Extract covers for every processed book that has never been searched for one — the
 * books uploaded before covers existed. Re-runnable: a searched book is stamped and
 * skipped from then on, and one that failed (file unreadable, bucket down) stays
 * unstamped for the next run.
 */
export async function backfillBookCovers(
  opts: { log?: (line: string) => void } = {},
): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});
  const pending = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(and(eq(books.status, "ready"), isNull(books.coverCheckedAt)))
    .orderBy(books.createdAt);

  const result: BackfillResult = { found: [], none: [], failed: [] };
  for (const { id, title } of pending) {
    try {
      const file = await loadBookFile(id);
      if (!file) {
        // No file row at all (a seed/demo book) is final; a row whose bytes couldn't be
        // read is not — leave that one for the next run.
        const [stored] = await db
          .select({ bookId: bookFiles.bookId })
          .from(bookFiles)
          .where(eq(bookFiles.bookId, id))
          .limit(1);
        if (stored) throw new Error("stored file could not be read");
        await saveBookCover(id, null);
      }
      const found = file ? await extractAndSaveCover(id, file.data) : false;
      (found ? result.found : result.none).push(id);
      log(`${found ? "cover   " : "no cover"} ${id} ${title}`);
    } catch (err) {
      result.failed.push(id);
      log(`FAILED   ${id} ${title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
