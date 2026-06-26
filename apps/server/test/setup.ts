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

// Isolate every test: start from an empty database.
beforeEach(resetDb);
