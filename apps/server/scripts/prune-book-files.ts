/**
 * Clear book file bytes from Postgres once they are verified in object storage, then
 * give the disk space back (spec 14, phase 3).
 *
 *   make books-prune-db                    # dry run: what would be cleared
 *   make books-prune-db args="--yes"       # clear, then VACUUM FULL book_files
 *   make books-prune-db args="--yes --book <id>"
 *
 * Take a backup first (`make backup`) and keep it — it is the last dump holding the
 * files. Every row is re-verified against the bucket before it is cleared; anything that
 * can't be proven identical is kept and the run exits non-zero. `VACUUM FULL` locks
 * `book_files` exclusively while it rewrites the table.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { pruneBookFileBytes } from "../src/storage/migrateBookFiles.js";

const args = process.argv.slice(2);
const dryRun = !args.includes("--yes");
const bookAt = args.indexOf("--book");
const bookId = bookAt >= 0 ? args[bookAt + 1] : undefined;
if (bookAt >= 0 && !bookId) {
  console.error("--book needs a book id");
  process.exit(2);
}

const tableSize = async () => {
  const rows = (await db.execute(
    sql`select pg_size_pretty(pg_total_relation_size('book_files')) as size`,
  )) as unknown as { size: string }[];
  return rows[0]?.size ?? "?";
};

try {
  if (dryRun) console.log("Dry run — nothing will be cleared. Pass --yes to clear.\n");
  const before = await tableSize();
  const result = await pruneBookFileBytes({ dryRun, bookId, log: (l) => console.log(l) });
  const bytes = result.cleared.reduce((n, c) => n + c.bytes, 0);
  console.log(
    `\n${dryRun ? "Would clear" : "Cleared"}: ${result.cleared.length} files, ${bytes} bytes` +
      `  kept (unverified): ${result.failed.length}`,
  );
  if (!dryRun && result.cleared.length > 0) {
    console.log("Reclaiming space: VACUUM FULL book_files …");
    await db.execute(sql`VACUUM FULL book_files`);
    console.log(`book_files on disk: ${before} → ${await tableSize()}`);
  }
  process.exit(result.failed.length > 0 ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
