import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .default("postgres://lexiprep:lexiprep@localhost:5432/lexiprep"),
  // Auth. In production these MUST be set; the dev defaults are insecure.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32)
    .default("dev-only-insecure-secret-change-me-0123456789"),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  // OpenRouter (AI contextual definitions). Optional: unset or "" disables the feature
  // (docker-compose `${VAR:-}` passes an empty string, so check truthiness, not presence).
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_DEFINITION_MODEL: z.string().default("google/gemini-3.1-flash-lite"),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Bound on the Free Dictionary fallback (dictionaryapi.dev). It sits inline in the
   * word-detail request, so an unbounded call hangs the whole word modal: the API has
   * been seen taking ~20s (and answering 522) for every word at once.
   */
  FREEDICT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
