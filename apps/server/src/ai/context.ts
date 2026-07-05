import { eq } from "drizzle-orm";
import { readEpub, readPdf, splitSentences } from "@lexiprep/core";
import { db } from "../db/client.js";
import { bookFiles } from "../db/schema.js";
import { isPdf } from "../queue/processBook.js";

/** Sentences outside this range read poorly in a prompt (fragments / whole paragraphs). */
const MIN_EXAMPLE_CHARS = 15;
const MAX_EXAMPLE_CHARS = 400;

/**
 * Pick `k` items evenly spread across the list, always including the first and last —
 * for 10 matches and k=5 that's indices 0,2,5,7,9: some from the beginning, the middle
 * and the end, instead of the first five. Preserves document order.
 */
export function pickSpread<T>(items: T[], k: number): T[] {
  if (k <= 0 || items.length === 0) return [];
  if (items.length <= k) return [...items];
  if (k === 1) return [items[0]!];
  const picked: T[] = [];
  let prev = -1;
  for (let i = 0; i < k; i++) {
    const idx = Math.round((i * (items.length - 1)) / (k - 1));
    if (idx !== prev) picked.push(items[idx]!);
    prev = idx;
  }
  return picked;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Up to `max` sentences from the stored book file that contain any surface form of the
 * word, spread across the text (see {@link pickSpread}). Re-reads the original file —
 * `book_words` keeps only one first-occurrence example per form — and matches on letter
 * boundaries so "fox" never hits "foxglove". Returns `[]` on any failure (missing file,
 * parse error): context is a prompt enhancer, never a reason for the job to die.
 */
export async function extractContextExamples(
  bookId: string,
  lemma: string,
  forms: string[],
  max = 5,
): Promise<string[]> {
  const targets = [...new Set([...forms, lemma].map((f) => f.trim()).filter(Boolean))];
  if (targets.length === 0) return [];

  try {
    const [file] = await db
      .select({ data: bookFiles.data })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, bookId))
      .limit(1);
    if (!file) return [];

    const parsed = isPdf(file.data) ? await readPdf(file.data) : await readEpub(file.data);
    const sentences = splitSentences(parsed.sections.map((s) => s.text).join("\n\n"));

    // Letter-boundary lookarounds: "fox" matches in "fox.", "'fox" and "fox's",
    // but never inside "foxglove". Unicode-aware so accented forms bound correctly.
    const pattern = new RegExp(
      `(?<!\\p{L})(?:${targets.map(escapeRegExp).join("|")})(?!\\p{L})`,
      "iu",
    );
    let matches = sentences.filter((s) => pattern.test(s));
    const wellSized = matches.filter(
      (s) => s.length >= MIN_EXAMPLE_CHARS && s.length <= MAX_EXAMPLE_CHARS,
    );
    if (wellSized.length > 0) matches = wellSized;

    return pickSpread(matches, max).map((s) => s.trim());
  } catch {
    return [];
  }
}
