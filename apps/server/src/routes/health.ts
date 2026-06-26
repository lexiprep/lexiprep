import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — no dependencies, always cheap.
  app.get("/health", async () => ({ status: "ok" }));

  // Readiness — verifies the database connection.
  app.get("/health/db", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { db: "up" };
    } catch (err) {
      app.log.warn({ err }, "db health check failed");
      reply.code(503);
      return { db: "down" };
    }
  });
}
