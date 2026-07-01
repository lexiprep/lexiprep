import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { demoRoutes } from "./routes/demo.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { bookRoutes } from "./routes/books.js";
import { wordRoutes } from "./routes/words.js";
import { reviewRoutes } from "./routes/review.js";
import { settingsRoutes } from "./routes/settings.js";
import { usageRoutes } from "./routes/usage.js";

export interface BuildAppOptions {
  logger?: boolean;
}

/** Construct the Fastify instance with all routes registered (no network I/O). */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  // credentials: true so Better Auth session cookies flow from the web origin.
  await app.register(cors, { origin: [env.WEB_ORIGIN], credentials: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  await app.register(authRoutes); // /api/auth/*
  await app.register(healthRoutes);
  await app.register(demoRoutes, { prefix: "/api" });
  await app.register(meRoutes, { prefix: "/api" });
  await app.register(bookRoutes, { prefix: "/api" });
  await app.register(wordRoutes, { prefix: "/api" });
  await app.register(reviewRoutes, { prefix: "/api" });
  await app.register(settingsRoutes, { prefix: "/api" });
  await app.register(usageRoutes, { prefix: "/api" });

  return app;
}
