/**
 * Seed `word_levels` from the bundled CEFR wordlists and backfill `book_words.level` for
 * every already-processed book. Idempotent (onConflictDoNothing + IS DISTINCT FROM), so
 * it is safe to run on every container start.
 *   pnpm --filter @lexiprep/server db:seed
 *
 * Two tiers, loaded in priority order (first writer wins on (language, lemma) conflict):
 *   1. en.csv      — VETTED CEFR-J + Octanove (8.7k lemmas). Trusted.
 *   2. en-freq.csv — ESTIMATED A1–C1 from overall-English frequency (Maximax67, ~51k).
 *      Fills only the words the vetted tier misses (e.g. `lord`, `knight`). source='freq'.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { wordLevels } from "./schema.js";

const LANGUAGE = "en";
const CHUNK = 1000;

type Row = { language: string; lemma: string; level: string; source: string };

function readCsv(relPath: string): Row[] {
  const csvPath = fileURLToPath(new URL(relPath, import.meta.url));
  if (!existsSync(csvPath)) return [];
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const [lemma, level, source] = line.split(",");
    if (!lemma || !level) continue;
    rows.push({ language: LANGUAGE, lemma, level, source: source ?? "unknown" });
  }
  return rows;
}

async function insertRows(rows: Row[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(wordLevels)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoNothing({ target: [wordLevels.language, wordLevels.lemma] });
  }
}

async function main() {
  // Vetted first so it wins on conflict; estimated freq tier fills the gaps.
  const vetted = readCsv("../../data/cefr/en.csv");
  const freq = readCsv("../../data/cefr/en-freq.csv");
  await insertRows(vetted);
  await insertRows(freq);
  const rows = [...vetted, ...freq];

  // Backfill existing books. coalesce(lemma, word) future-proofs for lemmatization.
  await db.execute(sql`
    UPDATE book_words bw SET level = wl.level
    FROM word_levels wl, books b
    WHERE bw.book_id = b.id
      AND wl.language = b.language
      AND wl.lemma = coalesce(bw.lemma, bw.word)
      AND bw.level IS DISTINCT FROM wl.level
  `);

  const counts = await db
    .select({ level: wordLevels.level, n: sql<number>`count(*)::int` })
    .from(wordLevels)
    .groupBy(wordLevels.level)
    .orderBy(wordLevels.level);
  console.log(`Seeded word_levels (${rows.length} rows in CSV):`);
  for (const c of counts) console.log(`  ${c.level}: ${c.n}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
