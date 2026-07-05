import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import { asc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, schema } from "../src/db/client.js";
import { createUser } from "./helpers/db.js";

const { definitions, wordSenses, definitionFetches } = schema;

// Split on drizzle's separator: pglite can't run multiple commands in one statement.
const MIGRATION_STATEMENTS = readFileSync(
  fileURLToPath(new URL("../drizzle/0003_normalize_definitions.sql", import.meta.url)),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

async function runMigration(): Promise<void> {
  for (const statement of MIGRATION_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

/**
 * The 0003 data migration explodes the legacy jsonb `definitions` rows into normalized
 * `word_senses` rows and records freedict fetch markers. Run the real SQL against the
 * test db to lock in its semantics (ordering, example coercion, negatives, idempotence).
 */
describe("0003_normalize_definitions", () => {
  beforeEach(async () => {
    await createUser(); // not needed by the migration; keeps the db shape realistic
    await db.insert(definitions).values([
      {
        language: "en",
        lemma: "say",
        source: "oewn-2025",
        senses: [
          { pos: "verb", gloss: "to utter words", example: "He said hello." },
          // Legacy attributed-quote example object — must be coerced to its text.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { pos: "noun", gloss: "a chance to speak", example: { text: "quoted", source: "x" } } as any,
        ],
      },
      { language: "en", lemma: "obscure", source: "freedict", senses: [{ pos: "adj", gloss: "not clear" }] },
      { language: "en", lemma: "zorgle", source: "freedict", senses: [] }, // cached negative
    ]);
  });

  it("explodes senses into ordered rows, coercing legacy example objects", async () => {
    await runMigration();

    const rows = await db
      .select()
      .from(wordSenses)
      .where(eq(wordSenses.lemma, "say"))
      .orderBy(asc(wordSenses.idx));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      idx: 0,
      pos: "verb",
      gloss: "to utter words",
      example: "He said hello.",
      source: "oewn-2025",
      ai: false,
      bookId: null,
    });
    expect(rows[1]).toMatchObject({ idx: 1, pos: "noun", example: "quoted" });
  });

  it("turns freedict rows (including empty negatives) into fetch markers", async () => {
    await runMigration();

    const markers = await db.select().from(definitionFetches);
    expect(markers.map((m) => m.lemma).sort()).toEqual(["obscure", "zorgle"]);
    // The negative produced no sense rows.
    expect(await db.select().from(wordSenses).where(eq(wordSenses.lemma, "zorgle"))).toHaveLength(0);
  });

  it("is idempotent (a second run duplicates nothing)", async () => {
    await runMigration();
    await runMigration();

    expect(await db.select().from(wordSenses)).toHaveLength(3); // 2 say + 1 obscure
    expect(await db.select().from(definitionFetches)).toHaveLength(2);
  });
});
