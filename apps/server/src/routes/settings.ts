import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import {
  getSettings,
  upsertSettings,
  SettingsError,
  type SettingsPatch,
} from "../review/settings.js";

/**
 * Per-user settings (spec 12) — currently the review-game knobs (`new_per_day`,
 * `max_per_day`, `auto_graduate_known`, `timezone`). Read returns the defaults when no row
 * exists; write is a partial patch that returns the full, current settings.
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/settings", async (request) => {
    return getSettings(request.user!.id);
  });

  app.put("/settings", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: SettingsPatch = {};

    if (body.newPerDay !== undefined) {
      if (typeof body.newPerDay !== "number" || !Number.isFinite(body.newPerDay)) {
        reply.code(400);
        return { error: "`newPerDay` must be a number" };
      }
      patch.newPerDay = body.newPerDay;
    }
    if (body.maxPerDay !== undefined) {
      if (typeof body.maxPerDay !== "number" || !Number.isFinite(body.maxPerDay)) {
        reply.code(400);
        return { error: "`maxPerDay` must be a number" };
      }
      patch.maxPerDay = body.maxPerDay;
    }
    if (body.autoGraduateKnown !== undefined) {
      if (typeof body.autoGraduateKnown !== "boolean") {
        reply.code(400);
        return { error: "`autoGraduateKnown` must be a boolean" };
      }
      patch.autoGraduateKnown = body.autoGraduateKnown;
    }
    if (body.timezone !== undefined) {
      if (body.timezone !== null && typeof body.timezone !== "string") {
        reply.code(400);
        return { error: "`timezone` must be a string or null" };
      }
      patch.timezone = body.timezone as string | null;
    }

    try {
      return await upsertSettings(request.user!.id, patch);
    } catch (err) {
      if (err instanceof SettingsError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });
}
