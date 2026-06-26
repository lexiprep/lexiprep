/**
 * One-time generator for the bundled CEFR wordlist (`apps/server/data/cefr/en.csv`).
 * NOT run at runtime — committed for provenance/reproducibility. Re-run with:
 *   pnpm --filter @lexiprep/server exec tsx scripts/build-cefr-csv.ts
 *
 * Combines two openly-licensed sources from `openlanguageprofiles/olp-en-cefrj`:
 *   - CEFR-J Vocabulary Profile 1.5  (A1–B2; CEFR-J terms — free, cite Tono Lab/TUFS)
 *   - Octanove Vocabulary Profile C1/C2 1.0  (C1–C2; CC BY-SA 4.0, Octanove Labs)
 * See data/cefr/NOTICE.md for attribution.
 *
 * Transform: lowercase + trim headwords, split slash-variants (a/b → a, b), keep only
 * single-token lexical entries (letters/apostrophe/hyphen — what our tokenizer emits),
 * and reduce to ONE level per lemma = the MINIMUM CEFR (the level it's first introduced).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCES = [
  {
    source: "cefrj",
    url: "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/cefrj-vocabulary-profile-1.5.csv",
  },
  {
    source: "octanove",
    url: "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/octanove-vocabulary-profile-c1c2-1.0.csv",
  },
] as const;

const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];
// Matches our tokenizer's normalized output: a letter, then letters/apostrophe/hyphen.
const TOKEN_RE = /^[a-z][a-z'-]*$/;

interface Entry {
  level: string;
  source: string;
}

async function main() {
  const map = new Map<string, Entry>();

  for (const { source, url } of SOURCES) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const fields = line.split(",");
      const headword = fields[0] ?? "";
      const level = (fields[2] ?? "").trim().toUpperCase();
      if (!CEFR_ORDER.includes(level)) continue;

      for (const raw of headword.split("/")) {
        const lemma = raw.trim().toLowerCase().replace(/’/g, "'");
        if (!TOKEN_RE.test(lemma)) continue;
        const existing = map.get(lemma);
        if (!existing || CEFR_ORDER.indexOf(level) < CEFR_ORDER.indexOf(existing.level)) {
          map.set(lemma, { level, source });
        }
      }
    }
  }

  const rows = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lemma, e]) => `${lemma},${e.level},${e.source}`);

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cefr");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "en.csv"), `lemma,level,source\n${rows.join("\n")}\n`, "utf8");

  // Summary (also the verification check).
  const byLevel: Record<string, number> = {};
  for (const e of map.values()) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
  console.log(`Wrote ${rows.length} lemmas to data/cefr/en.csv`);
  for (const l of CEFR_ORDER) console.log(`  ${l}: ${byLevel[l] ?? 0}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
