import type { FastifyInstance } from "fastify";
import { countWords } from "@lexiprep/core";

/**
 * Smoke endpoint proving the @lexiprep/core dependency works at runtime.
 * Replaced by the real upload -> analyze flow in a later phase.
 */
export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/demo", async () => {
    const sample = "The fox runs. The fox jumps. A dog barks at the fox.";
    return {
      source: sample,
      top: countWords(sample, { excludeStopwords: true }).slice(0, 5),
    };
  });
}
