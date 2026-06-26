/**
 * One-time generator for the bundled CEFR *frequency-fallback* wordlist
 * (`apps/server/data/cefr/en-freq.csv`). NOT run at runtime — committed for
 * provenance/reproducibility. Re-run with:
 *   pnpm --filter @lexiprep/server exec tsx scripts/build-cefr-freq-csv.ts
 *
 * Why this exists: the vetted list (`en.csv`, CEFR-J + Octanove, 8,679 lemmas) is small
 * and leaves ~half a real book's vocabulary unleveled — including common words it simply
 * never listed (`lord`, `knight`). This file is the *estimated* second tier: levels
 * derived from **overall English frequency** for a much wider vocabulary, used only to
 * fill words the vetted tier misses (seed loads vetted first; freq fills the gaps).
 *
 * Source: Maximax67/Words-CEFR-Dataset (MIT) — CEFR levels computed from the CEFR-J
 * dataset + Google Books 1-gram frequency. See data/cefr/NOTICE.md for attribution.
 *
 * Transform:
 *   - join word_pos.csv (word_id, level 1..6) → words.csv (word string),
 *   - one level per surface word = the MINIMUM across its POS rows (level first introduced),
 *   - keep only single-token lexical entries (letters/apostrophe/hyphen — what our
 *     tokenizer emits), matching `build-cefr-csv.ts`,
 *   - **DROP level 6 (C2)**: in this dataset C2 is a catch-all for rare/unknown words
 *     (~74% of entries; nonsense words land there too), not a real advanced grade. Keeping
 *     it would flood the C2 filter and empty the first-stage "unleveled" triage gate.
 *     Genuine advanced vocabulary stays covered by the vetted Octanove C2 tier. So we keep
 *     A1–C1 (the plausibly-correct band) and leave the rest unleveled, as before.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE =
  "https://raw.githubusercontent.com/Maximax67/Words-CEFR-Dataset/main/csv";
const WORDS_URL = `${BASE}/words.csv`;
const WORD_POS_URL = `${BASE}/word_pos.csv`;

// numeric 1..6 → CEFR letter. We keep 1..5 (A1–C1) and drop 6 (C2) — see header.
const LEVEL = ["A1", "A2", "B1", "B2", "C1"]; // index 0..4 ⇒ numeric 1..5
const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];
// Matches our tokenizer's normalized output: a letter, then letters/apostrophe/hyphen.
const TOKEN_RE = /^[a-z][a-z'-]*$/;

/** Fields are double-quoted, comma-separated; values we keep have no embedded commas
 *  (TOKEN_RE filters anything that would have broken a naive split). */
function cells(line: string): string[] {
  return line.split(",").map((c) => c.replace(/^"|"$/g, ""));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return res.text();
}

async function main() {
  // words.csv: word_id, word, stem_word_id
  const idToWord = new Map<string, string>();
  for (const line of (await fetchText(WORDS_URL)).split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const c = cells(line);
    if (c[0] && c[1]) idToWord.set(c[0], c[1]);
  }

  // word_pos.csv: word_pos_id, word_id, pos_tag_id, lemma_word_id, frequency_count, level
  // Reduce to the minimum numeric level per surface word.
  const minLevel = new Map<string, number>();
  for (const line of (await fetchText(WORD_POS_URL)).split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const c = cells(line);
    const word = idToWord.get(c[1]);
    if (!word) continue;
    const lvl = Number.parseInt(c[5], 10);
    if (!(lvl >= 1 && lvl <= 5)) continue; // skip non-numeric and C2 (6)
    const lemma = word.toLowerCase();
    if (!TOKEN_RE.test(lemma)) continue;
    const cur = minLevel.get(lemma);
    if (cur === undefined || lvl < cur) minLevel.set(lemma, lvl);
  }

  const rows = [...minLevel.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lemma, n]) => `${lemma},${LEVEL[n - 1]},freq`);

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cefr");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "en-freq.csv"), `lemma,level,source\n${rows.join("\n")}\n`, "utf8");

  // Summary (also the verification check).
  const byLevel: Record<string, number> = {};
  for (const n of minLevel.values()) byLevel[LEVEL[n - 1]] = (byLevel[LEVEL[n - 1]] ?? 0) + 1;
  console.log(`Wrote ${rows.length} lemmas to data/cefr/en-freq.csv (A1–C1, C2 dropped)`);
  for (const l of CEFR_ORDER) console.log(`  ${l}: ${byLevel[l] ?? 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
