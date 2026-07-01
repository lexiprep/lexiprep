import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import { env } from "../env.js";
import { FEATURE_META, PAID_FEATURES, isPaidFeature } from "../usage/features.js";
import { requireUsage } from "../usage/guard.js";
import { peek } from "../usage/service.js";

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  // Every route here requires a session.
  app.addHook("preHandler", requireAuth);

  // (a) Catalogue of paid-feature slugs + this user's live usage, so the FE can
  // gate proactively in one round trip.
  app.get("/usage/features", async (request) => {
    const userId = request.user!.id;
    const features = await Promise.all(
      PAID_FEATURES.map(async (slug) => {
        const usage = await peek(userId, slug);
        return {
          slug,
          label: FEATURE_META[slug].label,
          description: FEATURE_META[slug].description,
          limits: usage.windows.map((w) => ({ window: w.window, max: w.max })),
          usage,
        };
      }),
    );
    return { features };
  });

  // (b) Advisory single-slug check — returns whether the user still has usage.
  // Does NOT consume (real enforcement is the guard on the protected endpoint).
  app.post("/usage/check", async (request, reply) => {
    const { slug } = (request.body ?? {}) as { slug?: string };
    if (!isPaidFeature(slug)) {
      reply.code(400);
      return { error: "Unknown feature slug" };
    }
    return peek(request.user!.id, slug);
  });

  // Dev-only fake protected endpoint: proves the guard consumes + 429s at the limit
  // and drives the FE tooltip locally, without metering any currently-free feature.
  // Never mounted in production.
  if (env.NODE_ENV !== "production") {
    app.post(
      "/usage/demo",
      { preHandler: requireUsage("ai-word-definition-from-context") },
      async () => ({
        ok: true,
        feature: "ai-word-definition-from-context",
        stub: true,
      }),
    );
  }
}
