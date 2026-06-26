import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth/auth.js";

/**
 * Mounts Better Auth's handler at /api/auth/* by bridging Fastify <-> the Fetch
 * API it expects. Set-Cookie headers are forwarded individually so multiple
 * cookies aren't collapsed.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        body: request.body ? JSON.stringify(request.body) : undefined,
      });

      const response = await auth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      for (const cookie of response.headers.getSetCookie()) {
        reply.header("set-cookie", cookie);
      }
      reply.send(response.body ? await response.text() : null);
    },
  });
}
