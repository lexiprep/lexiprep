import { eq, sql } from "drizzle-orm";
import JSZip from "jszip";
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
 * Buffer (postgres.js) or a plain Uint8Array (pglite in tests). Also used by the
 * AI-definition context extractor (`ai/context.ts`), which re-reads stored files.
 */
export function isPdf(data: Uint8Array): boolean {
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
 * Algorithms that appear in `META-INF/encryption.xml` on perfectly readable EPUBs:
 * embedded-font obfuscation (IDPF's and Adobe's). The presence of encryption.xml is
 * therefore NOT by itself a DRM signal — only a content-encryption algorithm is.
 */
const FONT_OBFUSCATION = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

/**
 * Name the DRM scheme locking an EPUB's text, or null if its content is readable.
 *
 * Without this, a protected book still "parses": the zip inflates, but every XHTML file
 * is ciphertext, so extraction yields thousands of junk tokens that look like a word list.
 * Detect it up front and fail with something the owner can act on.
 *
 * Detection is by content-encryption algorithm (font obfuscation is ignored, see
 * {@link FONT_OBFUSCATION}); the scheme name comes from the sidecar file each system
 * ships — `license.lcpl` for Readium LCP, `rights.xml` for Adobe ADEPT.
 */
export async function epubDrmScheme(data: Uint8Array): Promise<string | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return null; // not a readable zip — let readEpub produce the real error
  }
  const xml = await zip.file("META-INF/encryption.xml")?.async("string");
  if (!xml) return null;

  const algorithms = [...xml.matchAll(/Algorithm="([^"]+)"/g)].map((m) => m[1]!);
  if (!algorithms.some((a) => !FONT_OBFUSCATION.has(a))) return null;

  if (zip.file("META-INF/license.lcpl")) return "Readium LCP";
  if (zip.file("META-INF/rights.xml")) return "Adobe DRM";
  return "DRM";
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
    const pdf = isPdf(file.data);
    // Bail before extraction: a DRM'd EPUB parses fine but yields ciphertext "words".
    if (!pdf) {
      const drm = await epubDrmScheme(file.data);
      if (drm) {
        throw new Error(
          `This EPUB is protected by ${drm}, so its text can't be read. Upload a DRM-free copy.`,
        );
      }
    }
    const parsed = pdf ? await readPdf(file.data) : await readEpub(file.data);
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

    const rows = analysis.frequencies
      // Single-character "words" aren't worth tracking. @lexiprep/core drops these at
      // tokenization (>=0.5.0); this guard keeps the rule even on an older core.
      .filter((f) => f.word.length > 1)
      .map((f) => ({
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
