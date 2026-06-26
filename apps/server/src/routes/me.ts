import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";

/** Example protected route — returns the authenticated user. */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", { preHandler: requireAuth }, async (request) => {
    return { user: request.user };
  });
}
