import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * Build the Drizzle client. In production/development we use postgres.js (which connects
 * lazily, so importing this module does not require a live DB). Under `NODE_ENV=test` the
 * app runs against an in-process Postgres (pglite) so the suite needs no external database
 * and the schema can be reset between tests. The pglite/test-only deps are imported lazily
 * so they never reach the production bundle. The two clients share one `PgDatabase` API
 * surface, so the cast is safe — the app code only uses methods common to both dialects.
 */
async function createDb(): Promise<PostgresJsDatabase<typeof schema>> {
  if (env.NODE_ENV === "test") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    return drizzlePglite(new PGlite(), { schema }) as unknown as PostgresJsDatabase<
      typeof schema
    >;
  }
  return drizzle(postgres(env.DATABASE_URL, { max: 10 }), { schema });
}

export const db = await createDb();
export { schema };
