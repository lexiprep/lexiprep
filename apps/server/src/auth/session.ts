import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";

export type SessionUser = (typeof auth.$Infer.Session)["user"];

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the {@link requireAuth} preHandler. */
    user?: SessionUser;
  }
}

/** Resolve the current session from request cookies/headers, or null. */
export async function getSession(request: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
}

/** preHandler that 401s unauthenticated requests and attaches `request.user`. */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await getSession(request);
  if (!session) {
    await reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  request.user = session.user;
}
