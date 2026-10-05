import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { bookFiles } from "../db/schema.js";
import { getObjectStore, objectKeyFor, sha256Hex } from "./bookFiles.js";

/** One book's file as it now sits in the bucket — a line of the migration manifest. */
export interface ManifestEntry {
  bookId: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface CopyResult {
  /** Copied to the bucket and verified in this run (or, on a dry run, would be). */
  copied: string[];
  /** Book ids whose copy failed; their rows are unchanged. */
  failed: { bookId: string; error: string }[];
  /** Every row that has an object after the run, whenever it got there. */
  manifest: ManifestEntry[];
}

export interface MigrateOptions {
  dryRun?: boolean;
  /** Limit the run to one book — a canary before the full pass. */
  bookId?: string;
  log?: (line: string) => void;
}

/**
 * Phase 2 of spec 14: copy every book file that lives only in Postgres to the bucket.
 * Each file is uploaded, **downloaded back and compared** (size + SHA-256) with the
 * Postgres bytes, and only then is `object_key` recorded. `data` is never touched here,
 * so the run can be repeated or abandoned at any point: finished rows are skipped and a
 * failed row is left exactly as it was. One file is held in memory at a time.
 */
export async function copyBookFilesToBucket(opts: MigrateOptions = {}): Promise<CopyResult> {
  const log = opts.log ?? (() => {});
  const store = await getObjectStore();
  if (!store) throw new Error("Object storage is not configured (R2_* env)");

  const pending = await db
    .select({ bookId: bookFiles.bookId, filename: bookFiles.filename })
    .from(bookFiles)
    .where(
      and(
        isNotNull(bookFiles.data),
        isNull(bookFiles.objectKey),
        opts.bookId ? eq(bookFiles.bookId, opts.bookId) : undefined,
      ),
    )
    .orderBy(bookFiles.createdAt);

  const copied: string[] = [];
  const failed: CopyResult["failed"] = [];
  for (const { bookId, filename } of pending) {
    const objectKey = objectKeyFor(bookId, filename);
    try {
      const [row] = await db
        .select({ data: bookFiles.data, mimeType: bookFiles.mimeType })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, bookId))
        .limit(1);
      if (!row?.data) continue; // deleted or cleared since the list was read
      const data = Buffer.from(row.data);
      const sha256 = sha256Hex(data);
      if (opts.dryRun) {
        log(`would copy ${bookId} → ${objectKey} (${data.length} bytes)`);
        copied.push(bookId);
        continue;
      }

      await store.put(objectKey, data, row.mimeType ?? undefined);
      const back = await store.get(objectKey);
      if (!back || back.length !== data.length || sha256Hex(back) !== sha256) {
        throw new Error("the object read back from the bucket does not match Postgres");
      }
      const updated = await db
        .update(bookFiles)
        .set({ objectKey, sha256 })
        .where(and(eq(bookFiles.bookId, bookId), isNull(bookFiles.objectKey)))
        .returning({ bookId: bookFiles.bookId });
      if (updated.length === 0) {
        // The book was deleted while its file was being copied — don't leave the object.
        await store.delete(objectKey).catch(() => {});
        continue;
      }
      log(`copied ${bookId} → ${objectKey} (${data.length} bytes, sha256 ${sha256})`);
      copied.push(bookId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`FAILED ${bookId}: ${error}`);
      failed.push({ bookId, error });
    }
  }

  const manifest = await db
    .select({
      bookId: bookFiles.bookId,
      objectKey: bookFiles.objectKey,
      sizeBytes: bookFiles.sizeBytes,
      sha256: bookFiles.sha256,
    })
    .from(bookFiles)
    .where(isNotNull(bookFiles.objectKey))
    .orderBy(bookFiles.objectKey);
  return {
    copied,
    failed,
    manifest: manifest.map((m) => ({ ...m, objectKey: m.objectKey! })),
  };
}
