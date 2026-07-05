import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { definitionFetches, wordSenses, type WordSense } from "../db/schema.js";

const FREEDICT_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const MAX_SENSES = 5;

/**
 * Shared dictionary reads/writes over the normalized `word_senses` table (one row per
 * sense; `book_id IS NULL` = the global dictionary, `book_id` set = per-book AI senses).
 * Everything that used to read the old jsonb `definitions` table goes through here.
 */

function toSense(row: { pos: string; gloss: string; example: string | null }): WordSense {
  return row.example
    ? { pos: row.pos, gloss: row.gloss, example: row.example }
    : { pos: row.pos, gloss: row.gloss };
}

/** Dictionary senses for one lemma, in stored order. Null = no rows (vs [] = negative). */
export async function getDictionarySenses(
  language: string,
  lemma: string,
): Promise<WordSense[] | null> {
  const rows = await db
    .select({ pos: wordSenses.pos, gloss: wordSenses.gloss, example: wordSenses.example })
    .from(wordSenses)
    .where(
      and(
        eq(wordSenses.language, language),
        eq(wordSenses.lemma, lemma),
        isNull(wordSenses.bookId),
      ),
    )
    .orderBy(asc(wordSenses.idx));
  return rows.length > 0 ? rows.map(toSense) : null;
}

/** Dictionary senses for many lemmas in one query (study list / flashcards). */
export async function getDictionarySensesForLemmas(
  language: string,
  lemmas: string[],
): Promise<Map<string, WordSense[]>> {
  const map = new Map<string, WordSense[]>();
  if (lemmas.length === 0) return map;
  const rows = await db
    .select({
      lemma: wordSenses.lemma,
      pos: wordSenses.pos,
      gloss: wordSenses.gloss,
      example: wordSenses.example,
    })
    .from(wordSenses)
    .where(
      and(
        eq(wordSenses.language, language),
        inArray(wordSenses.lemma, lemmas),
        isNull(wordSenses.bookId),
      ),
    )
    .orderBy(asc(wordSenses.lemma), asc(wordSenses.idx));
  for (const row of rows) {
    const list = map.get(row.lemma) ?? [];
    list.push(toSense(row));
    map.set(row.lemma, list);
  }
  return map;
}

/** The AI senses generated for a lemma in one book, in stored order. Null = none. */
export async function getAiSenses(
  bookId: string,
  lemma: string,
): Promise<WordSense[] | null> {
  const rows = await db
    .select({ pos: wordSenses.pos, gloss: wordSenses.gloss, example: wordSenses.example })
    .from(wordSenses)
    .where(
      and(eq(wordSenses.bookId, bookId), eq(wordSenses.lemma, lemma), eq(wordSenses.ai, true)),
    )
    .orderBy(asc(wordSenses.idx));
  return rows.length > 0 ? rows.map(toSense) : null;
}

interface FreeDictEntry {
  meanings?: {
    partOfSpeech?: string;
    definitions?: { definition?: string; example?: string }[];
  }[];
}

/**
 * Fallback for words not in the bundled dictionary: fetch from the Free Dictionary API
 * (Wiktionary, CC BY-SA) and cache the result, so each missing word hits the network at
 * most once. A definitive answer (senses, or a 404 = word absent) records a
 * `definition_fetches` marker; only the marker's winning inserter writes sense rows, so
 * concurrent lookups can't duplicate them. Returns null on transient errors (nothing
 * recorded) so the word can be retried later.
 */
export async function fetchAndCacheDefinition(
  language: string,
  lemma: string,
): Promise<WordSense[] | null> {
  let senses: WordSense[];
  try {
    const res = await fetch(FREEDICT_URL + encodeURIComponent(lemma));
    if (res.status === 404) {
      senses = []; // definitively absent — cache the negative via the fetch marker
    } else if (!res.ok) {
      return null; // transient (rate limit / outage) — don't cache, allow retry
    } else {
      const data = (await res.json()) as FreeDictEntry[];
      senses = [];
      const seen = new Set<string>();
      for (const entry of data) {
        for (const m of entry.meanings ?? []) {
          for (const d of m.definitions ?? []) {
            const gloss = d.definition?.trim();
            if (!gloss || seen.has(gloss)) continue;
            seen.add(gloss);
            senses.push({ pos: m.partOfSpeech ?? "", gloss, example: d.example });
            if (senses.length >= MAX_SENSES) break;
          }
          if (senses.length >= MAX_SENSES) break;
        }
        if (senses.length >= MAX_SENSES) break;
      }
    }
  } catch {
    return null; // network error — don't cache
  }

  await db.transaction(async (tx) => {
    const won = await tx
      .insert(definitionFetches)
      .values({ language, lemma })
      .onConflictDoNothing({ target: [definitionFetches.language, definitionFetches.lemma] })
      .returning({ id: definitionFetches.id });
    if (won.length === 0 || senses.length === 0) return; // lost the race, or negative
    await tx.insert(wordSenses).values(
      senses.map((s, idx) => ({
        language,
        lemma,
        idx,
        pos: s.pos,
        gloss: s.gloss,
        example: s.example ?? null,
        source: "freedict",
      })),
    );
  });
  return senses;
}

/** Has the Free Dictionary API already given a definitive answer for this lemma? */
export async function hasDefinitionFetch(language: string, lemma: string): Promise<boolean> {
  const [row] = await db
    .select({ id: definitionFetches.id })
    .from(definitionFetches)
    .where(and(eq(definitionFetches.language, language), eq(definitionFetches.lemma, lemma)))
    .limit(1);
  return !!row;
}
