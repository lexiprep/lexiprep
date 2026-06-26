import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/client.js";
import { user, session, account, verification } from "../db/auth-schema.js";
import { env } from "../env.js";

/**
 * Better Auth instance. Email + password only for v1 (no email verification, so
 * self-hosting needs no SMTP). Social logins / verification are config additions,
 * not rewrites. Backed by our Drizzle/Postgres tables (user/session/account/
 * verification live in db/auth-schema.ts).
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_ORIGIN],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
});

export type AuthSession = typeof auth.$Infer.Session;
