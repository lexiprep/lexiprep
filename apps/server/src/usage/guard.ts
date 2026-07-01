import type { FastifyReply, FastifyRequest } from "fastify";
import { consume, type WindowUsage } from "./service.js";
import type { PaidFeatureSlug } from "./features.js";

/** Raised when a metered feature is over its limit. Carries the 429 details. */
export class UsageLimitError extends Error {
  constructor(
    readonly slug: PaidFeatureSlug,
    readonly retryAfter: number, // seconds
    readonly windows: WindowUsage[],
  ) {
    super(`Usage limit reached for ${slug}`);
    this.name = "UsageLimitError";
  }
}

/** Seconds until re-admission: the latest reset among the exceeded windows. */
export function retryAfterSeconds(windows: WindowUsage[]): number {
  const now = Date.now();
  const resets = windows
    .filter((w) => w.used >= w.max && w.resetAt)
    .map((w) => new Date(w.resetAt!).getTime());
  if (resets.length === 0) return 1;
  return Math.max(1, Math.ceil((Math.max(...resets) - now) / 1000));
}

/**
 * Reusable Fastify preHandler ("middleware") that enforces a feature's usage limit.
 * Attach to any route as `{ preHandler: requireUsage(slug) }`; `requireAuth` must run
 * first (a file-level `addHook`, or listed before this in the preHandler array) so
 * `request.user` is set. It consumes one use atomically *before* the handler runs, so
 * enforcement can't be forgotten or bypassed — once the limit is hit the request 429s
 * and the handler never executes.
 *
 * It consumes up front, so if the handler later fails the use is still charged. That's
 * fine for cheap/stub handlers. When a real, expensive call (e.g. an LLM) is wired,
 * move to reserve+refund inside the handler instead: `consume()` to reserve, run the
 * work, `refund(eventId)` on failure — never consume *after* the work.
 */
export function requireUsage(slug: PaidFeatureSlug) {
  return async function usageGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const result = await consume(request.user!.id, slug);
    if (!result.allowed) {
      const retryAfter = retryAfterSeconds(result.windows);
      reply.header("Retry-After", String(retryAfter));
      await reply.code(429).send({ error: "Usage limit reached", slug, retryAfter });
    }
  };
}
