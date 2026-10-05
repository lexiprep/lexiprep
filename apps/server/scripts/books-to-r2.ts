/**
 * Copy the book files that still live in Postgres to object storage (spec 14, phase 2).
 *
 *   make books-to-r2                       # copy everything not copied yet
 *   make books-to-r2 args="--dry-run"      # list what would be copied
 *   make books-to-r2 args="--book <id>"    # one book first, as a canary
 *
 * Safe to re-run: verified rows are skipped, and nothing is ever removed from Postgres
 * here. Ends with a manifest (one JSON line per object) to check against the bucket, and
 * exits non-zero if any file failed.
 */
import { copyBookFilesToBucket } from "../src/storage/migrateBookFiles.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bookAt = args.indexOf("--book");
const bookId = bookAt >= 0 ? args[bookAt + 1] : undefined;
if (bookAt >= 0 && !bookId) {
  console.error("--book needs a book id");
  process.exit(2);
}

try {
  const result = await copyBookFilesToBucket({ dryRun, bookId, log: (l) => console.log(l) });
  console.log("\n--- manifest (objects recorded in the database) ---");
  for (const entry of result.manifest) console.log(JSON.stringify(entry));
  const bytes = result.manifest.reduce((n, m) => n + m.sizeBytes, 0);
  console.log(
    `\n${dryRun ? "Would copy" : "Copied"}: ${result.copied.length}  failed: ${result.failed.length}` +
      `  in bucket: ${result.manifest.length} objects, ${bytes} bytes`,
  );
  process.exit(result.failed.length > 0 ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
