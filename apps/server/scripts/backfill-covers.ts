/**
 * Extract cover images for the books uploaded before covers existed, and shrink any
 * cover still stored at its original size.
 *
 *   make books-covers
 *
 * Safe to re-run: only books never searched for a cover are touched, and one whose file
 * couldn't be read stays pending for the next run. `make migrate` runs this on every
 * deploy, where it is a no-op once the library is caught up. Exits non-zero if any book
 * failed.
 */
import { backfillBookCovers } from "../src/storage/bookCovers.js";

try {
  const result = await backfillBookCovers({ log: (l) => console.log(l) });
  console.log(
    `\nCovers: ${result.found.length}  without one: ${result.none.length}` +
      `  shrunk: ${result.shrunk.length}  failed: ${result.failed.length}`,
  );
  if (result.libraryMissing) {
    console.log(
      "The image library (sharp) is not installed, so covers were left at their original" +
        " size. Run `make install`, then `make books-covers`.",
    );
  }
  process.exit(result.failed.length > 0 || result.libraryMissing ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
