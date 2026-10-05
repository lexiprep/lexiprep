import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { bookFiles } from "../db/schema.js";
import { env } from "../env.js";
import { S3Client } from "./s3.js";

/**
 * Where a book's original file lives (docs/specs/14-book-file-storage.md). With object
 * storage configured the bytes are in the bucket and `book_files` holds only the key;
 * without it they stay in `book_files.data`, as before. Everything that reads or writes
 * a book file goes through here.
 */
export interface ObjectStore {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  presignPut(key: string, expiresSeconds: number): Promise<string>;
}

/** Largest file accepted through the server (`POST /api/books`); bigger ones go direct. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

let override: ObjectStore | null | undefined;
let configured: Promise<ObjectStore | null> | undefined;

/** The bucket, or null when object storage isn't configured (dev, tests, plain self-host). */
export async function getObjectStore(): Promise<ObjectStore | null> {
  if (override !== undefined) return override;
  // docker-compose passes `${VAR:-}`, so "unset" arrives as an empty string.
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  configured ??= S3Client.create({
    endpoint: R2_ENDPOINT,
    region: "auto",
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
  }).catch((err) => {
    configured = undefined; // e.g. the client library isn't installed yet — retry next time
    throw err;
  });
  return configured;
}

/** Swap the bucket in tests (`null` = not configured; `undefined` = back to the env). */
export function setObjectStoreForTests(store: ObjectStore | null | undefined): void {
  override = store;
}

export const sha256Hex = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** `<prefix>/<bookId>.<ext>` — the book id is a UUID, so keys never collide or move. */
export function objectKeyFor(bookId: string, filename: string): string {
  const ext = /\.pdf$/i.test(filename) ? "pdf" : "epub";
  const prefix = env.BOOKS_R2_PREFIX.replace(/^\/+|\/+$/g, "");
  return `${prefix}/${bookId}.${ext}`;
}

export interface StoredBookFile {
  data: Buffer | null;
  objectKey: string | null;
  sha256: string;
}

/**
 * Put an uploaded file where it belongs and return the `book_files` columns that record
 * it. A failed bucket upload throws — there is deliberately no fallback to Postgres,
 * which would quietly regrow the table this moves files out of.
 */
export async function storeBookFile(
  bookId: string,
  input: { filename: string; mimeType: string | undefined; data: Buffer },
): Promise<StoredBookFile> {
  const sha256 = sha256Hex(input.data);
  const store = await getObjectStore();
  if (!store) return { data: input.data, objectKey: null, sha256 };
  const objectKey = objectKeyFor(bookId, input.filename);
  await store.put(objectKey, input.data, input.mimeType);
  return { data: null, objectKey, sha256 };
}

/** Best-effort removal of a book's object; a failure leaves an orphan, never an error. */
export async function deleteBookObject(
  objectKey: string | null | undefined,
  log?: { warn: (obj: object, msg: string) => void },
): Promise<void> {
  if (!objectKey) return;
  try {
    await (await getObjectStore())?.delete(objectKey);
  } catch (err) {
    log?.warn({ err, objectKey }, "book file: object delete failed (orphan left)");
  }
}

export interface LoadedBookFile {
  data: Buffer;
  filename: string;
  mimeType: string | null;
}

/**
 * A book's original bytes, or null when there are none. Reads the bucket when the row has
 * an object key and falls back to the bytes still in Postgres if that read fails — which
 * is what keeps books readable between copying them to the bucket and clearing the table.
 * Fills in `sha256` the first time a directly-uploaded object is read.
 */
export async function loadBookFile(
  bookId: string,
  log?: { warn: (obj: object, msg: string) => void },
): Promise<LoadedBookFile | null> {
  const [meta] = await db
    .select({
      filename: bookFiles.filename,
      mimeType: bookFiles.mimeType,
      objectKey: bookFiles.objectKey,
      sha256: bookFiles.sha256,
    })
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId))
    .limit(1);
  if (!meta) return null;
  const found = (data: Buffer): LoadedBookFile => ({
    data,
    filename: meta.filename,
    mimeType: meta.mimeType,
  });

  if (meta.objectKey) {
    try {
      const store = await getObjectStore();
      if (!store) throw new Error("object storage is not configured");
      const data = await store.get(meta.objectKey);
      if (!data) throw new Error("object not found");
      if (!meta.sha256) {
        await db
          .update(bookFiles)
          .set({ sha256: sha256Hex(data) })
          .where(eq(bookFiles.bookId, bookId));
      }
      return found(data);
    } catch (err) {
      log?.warn({ err, bookId, objectKey: meta.objectKey }, "book file: bucket read failed");
    }
  }

  const [row] = await db
    .select({ data: bookFiles.data })
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId))
    .limit(1);
  // pglite hands back a plain Uint8Array; normalize so callers always get a Buffer.
  return row?.data ? found(Buffer.from(row.data)) : null;
}
