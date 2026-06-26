import { eq, sql } from "drizzle-orm";
import { readEpub, readPdf, analyzeBook, ENGLISH_STOPWORDS } from "@lexiprep/core";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { books, bookFiles, bookWords } from "../db/schema.js";

const INSERT_CHUNK = 1000;

/** Normalize "en-US" -> "en" so it matches the per-user known-words language. */
function baseLanguage(lang: string | undefined): string {
  return (lang ?? "en").slice(0, 2).toLowerCase();
}

/**
 * Pick the reader by content, not filename: PDFs start with "%PDF-", EPUBs are
 * zips. Compares raw bytes so it works whether the driver hands back a Node
 * Buffer (postgres.js) or a plain Uint8Array (pglite in tests).
 */
function isPdf(data: Uint8Array): boolean {
  // "%PDF-" = 0x25 0x50 0x44 0x46 0x2d
  return (
    data.length >= 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

/**
 * Background job: load the stored book (EPUB or PDF), extract the frequency list
 * via @lexiprep/core, and persist book_words. Idempotent (clears prior words).
 */
export async function processBook(
  bookId: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  const [file] = await db
    .select()
    .from(bookFiles)
    .where(eq(bookFiles.bookId, bookId))
    .limit(1);
  if (!file) {
    // No stored file (e.g. a reprocess of a seed/demo book that never had one). Fail
    // cleanly so the status doesn't hang on "processing" forever.
    logger.warn({ bookId }, "process-book: no file found");
    await db
      .update(books)
      .set({ status: "failed", error: "No stored file for this book" })
      .where(eq(books.id, bookId));
    return;
  }

  await db
    .update(books)
    .set({ status: "processing", error: null })
    .where(eq(books.id, bookId));

  try {
    const parsed = isPdf(file.data) ? await readPdf(file.data) : await readEpub(file.data);
    // lemmatize: group conjugations under a base form (used for level lookup + grouping)
    // detectProperNouns: flag names from mid-sentence capitalization (spec 06)
    // captureExamples: first-occurrence context sentence per word (spec 03) — every word
    // gets one, so the modal always has a context match even when no definition exists.
    const analysis = analyzeBook(parsed, {
      lemmatize: true,
      detectProperNouns: true,
      captureExamples: true,
    });
    const lang = baseLanguage(parsed.metadata.language);

    const rows = analysis.frequencies.map((f) => ({
      bookId,
      word: f.word,
      lemma: f.lemma ?? null,
      count: f.count,
      isStopword: ENGLISH_STOPWORDS.has(f.word),
      properNoun: f.properNoun ?? null,
      example: f.example ?? null,
    }));

    await db.transaction(async (tx) => {
      await tx.delete(bookWords).where(eq(bookWords.bookId, bookId));
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx.insert(bookWords).values(rows.slice(i, i + INSERT_CHUNK));
      }
      // Enrichment (spec 03): set CEFR level from the bundled word_levels. Matches
      // coalesce(lemma, word) so inflected forms are leveled via their base form.
      await tx.execute(sql`
        UPDATE book_words bw SET level = wl.level
        FROM word_levels wl
        WHERE bw.book_id = ${bookId}
          AND wl.language = ${lang}
          AND wl.lemma = coalesce(bw.lemma, bw.word)
      `);
      // Proper nouns (spec 06): auto-ignore confirmed names so the owner never sorts them.
      // Precedence — "name overrides freq, not vetted": skip groups that carry a vetted
      // (CEFR-J/Octanove) level. onConflictDoNothing preserves any prior user choice.
      await tx.execute(sql`
        WITH groups AS (
          SELECT b.user_id, b.language AS lang, coalesce(bw.lemma, bw.word) AS lemma,
                 bool_or(bw.proper_noun = 'confirmed') AS is_name
          FROM book_words bw
          JOIN books b ON b.id = bw.book_id
          WHERE bw.book_id = ${bookId}
          GROUP BY b.user_id, b.language, coalesce(bw.lemma, bw.word)
        )
        INSERT INTO user_words (user_id, language, lemma, status)
        SELECT g.user_id, g.lang, g.lemma, 'ignored'
        FROM groups g
        WHERE g.is_name
          AND NOT EXISTS (
            SELECT 1 FROM word_levels wl
            WHERE wl.language = g.lang AND wl.lemma = g.lemma
              AND wl.source IN ('cefrj', 'octanove')
          )
        ON CONFLICT (user_id, language, lemma) DO NOTHING
      `);
      await tx
        .update(books)
        .set({
          status: "ready",
          title: parsed.metadata.title ?? undefined,
          author: parsed.metadata.author ?? null,
          language: lang,
          identifier: parsed.metadata.identifier ?? null,
          chapterCount: analysis.sectionCount,
          tokenCount: analysis.totalTokens,
          error: null,
        })
        .where(eq(books.id, bookId));
    });

    logger.info({ bookId, uniqueWords: rows.length }, "process-book: ready");
  } catch (err) {
    logger.error({ bookId, err }, "process-book: failed");
    await db
      .update(books)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(books.id, bookId));
  }
}
