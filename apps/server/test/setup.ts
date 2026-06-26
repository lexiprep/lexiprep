import { beforeEach } from "vitest";
import { pushSchema } from "drizzle-kit/api";
import { db, schema } from "../src/db/client.js";
import { resetDb } from "./helpers/db.js";

// Create every table in the in-process pglite database, once per test worker, by diffing
// the live (empty) DB against the Drizzle schema — the same mechanism as `drizzle-kit push`.
const { apply } = await pushSchema(
  schema as unknown as Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db as any,
);
await apply();

// drizzle-kit/api (imported above for schema push) installs an *enumerable*
// `Array.prototype.random`, and pdf.js — used by `@lexiprep/core`'s `readPdf` —
// refuses to run while `Array.prototype` is polluted. drizzle-kit is dev-only
// (not a runtime dependency), so production is unaffected; strip it here so
// PDF-processing tests can run pdf.js in the same process.
delete (Array.prototype as { random?: unknown }).random;

// Isolate every test: start from an empty database.
beforeEach(resetDb);
