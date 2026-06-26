/**
 * Download Open English WordNet and (re)load it into the `definitions` table.
 * Run any time to update the dictionary:  make dict-update   (or: pnpm db:definitions)
 *
 * Safety: the new data is downloaded and fully parsed in memory FIRST; only then are
 * rows written, via UPSERT (insert or update on conflict). Nothing is deleted, so the
 * existing dictionary stays fully available throughout — no downtime if a download fails.
 *
 * Source: Open English WordNet 2025 (CC BY 4.0). https://github.com/globalwordnet/english-wordnet
 */
import JSZip from "jszip";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { definitions, type WordSense } from "../src/db/schema.js";

const ZIP_URL =
  "https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip";
const SOURCE = "oewn-2025";
const LANGUAGE = "en";
const MAX_SENSES = 5; // keep it short — the few most useful meanings
const CHUNK = 500;

// WordNet POS codes → readable labels (s = adjective satellite).
const POS_LABEL: Record<string, string> = {
  n: "noun",
  v: "verb",
  a: "adjective",
  s: "adjective",
  r: "adverb",
};

interface Synset {
  definition?: string[];
  // OEWN examples are sometimes attributed-quote objects `{ text, source }`, not strings.
  example?: (string | { text?: string })[];
}

/** First example as a plain string (OEWN sometimes wraps it as `{ text, source }`). */
function firstExample(example?: (string | { text?: string })[]): string | undefined {
  const ex = example?.[0];
  if (typeof ex === "string") return ex;
  if (ex && typeof ex === "object" && typeof ex.text === "string") return ex.text;
  return undefined;
}
interface EntryPos {
  sense?: { synset: string }[];
}

async function main() {
  console.log("Downloading Open English WordNet…");
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const names = Object.keys(zip.files);

  // 1. synset id -> { gloss, example } from the lexname files (everything but entries/frames).
  console.log("Parsing synsets…");
  const synsets = new Map<string, { gloss: string; example?: string }>();
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith("entries-") || name === "frames.json") {
      continue;
    }
    const obj = JSON.parse(await zip.files[name]!.async("string")) as Record<string, Synset>;
    for (const [id, s] of Object.entries(obj)) {
      const gloss = s.definition?.[0];
      if (gloss) synsets.set(id, { gloss, example: firstExample(s.example) });
    }
  }

  // 2. lemma -> senses, joining each entry's senses to their synset glosses.
  console.log("Parsing entries…");
  const byLemma = new Map<string, WordSense[]>();
  for (const name of names) {
    if (!name.startsWith("entries-")) continue;
    const obj = JSON.parse(await zip.files[name]!.async("string")) as Record<
      string,
      Record<string, EntryPos>
    >;
    for (const [rawLemma, posMap] of Object.entries(obj)) {
      const lemma = rawLemma.toLowerCase();
      if (lemma.includes(" ")) continue; // single tokens only (matches book_words)
      const list = byLemma.get(lemma) ?? [];
      for (const [pos, entry] of Object.entries(posMap)) {
        const label = POS_LABEL[pos] ?? pos;
        for (const sense of entry.sense ?? []) {
          const syn = synsets.get(sense.synset);
          if (syn) list.push({ pos: label, gloss: syn.gloss, example: syn.example });
        }
      }
      if (list.length) byLemma.set(lemma, list);
    }
  }

  // De-dupe by gloss and cap to the most useful few.
  const rows = [...byLemma].map(([lemma, all]) => {
    const seen = new Set<string>();
    const senses: WordSense[] = [];
    for (const s of all) {
      if (seen.has(s.gloss)) continue;
      seen.add(s.gloss);
      senses.push(s);
      if (senses.length >= MAX_SENSES) break;
    }
    return { language: LANGUAGE, lemma, senses, source: SOURCE };
  });
  console.log(`Parsed ${rows.length} lemmas. Upserting…`);

  // 3. Upsert — never deletes, so the live dictionary is updated in place.
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(definitions)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [definitions.language, definitions.lemma],
        set: {
          senses: sql`excluded.senses`,
          source: sql`excluded.source`,
          updatedAt: sql`now()`,
        },
      });
    done += Math.min(CHUNK, rows.length - i);
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(definitions);
  console.log(`Done. Upserted ${done}; definitions table now holds ${n} entries.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
