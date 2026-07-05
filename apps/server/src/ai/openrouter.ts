import { env } from "../env.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Minimal OpenRouter chat client for structured-output calls (ported from clara's
 * `openrouterService.js`, TS + native fetch). One choke point, provider-config-free:
 * the caller passes the model; this module owns transport, auth, JSON-schema response
 * enforcement, usage accounting and the retry policy — network errors up to 3 attempts,
 * one retry on 5xx, 4xx terminal (a bad request never gets better by retrying).
 */
export class OpenRouterError extends Error {
  readonly status: number | null;
  readonly body: unknown;

  constructor(
    message: string,
    opts: { status?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OpenRouterError";
    this.status = opts.status ?? null;
    this.body = opts.body;
  }
}

export interface ChatJsonParams {
  model: string;
  system: string;
  user: string;
  /** Name for the response_format json_schema block. */
  schemaName: string;
  /** Strict JSON schema the model output must satisfy. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  timeoutMs?: number;
  /** OpenRouter extras spread into the request body (e.g. `{reasoning: {effort: "low"}}`). */
  providerOpts?: Record<string, unknown>;
}

export interface ChatJsonResult<T> {
  data: T;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** The model that actually served the request (OpenRouter may resolve aliases). */
  model: string;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/** One structured-output chat completion; resolves to the parsed JSON + usage. */
export async function chatJson<T>(p: ChatJsonParams): Promise<ChatJsonResult<T>> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new OpenRouterError("OPENROUTER_API_KEY is not set");
  const timeoutMs = p.timeoutMs ?? env.OPENROUTER_TIMEOUT_MS;

  const body = JSON.stringify({
    model: p.model,
    messages: [
      { role: "system", content: p.system },
      { role: "user", content: p.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: p.schemaName, strict: true, schema: p.schema },
    },
    // Ask OpenRouter to report token counts + cost with the response.
    usage: { include: true },
    max_tokens: p.maxTokens ?? 1000,
    ...p.providerOpts,
  });

  let networkAttempts = 0;
  let serverRetried = false;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.BETTER_AUTH_URL,
          "X-Title": "LexiPrep",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      networkAttempts += 1;
      if (networkAttempts >= 3) {
        throw new OpenRouterError("OpenRouter request failed (network)", { cause });
      }
      continue;
    }

    if (res.status >= 500) {
      const resBody = await safeBody(res);
      if (serverRetried) {
        throw new OpenRouterError(`OpenRouter error ${res.status}`, {
          status: res.status,
          body: resBody,
        });
      }
      serverRetried = true;
      continue;
    }
    if (!res.ok) {
      throw new OpenRouterError(`OpenRouter rejected the request (${res.status})`, {
        status: res.status,
        body: await safeBody(res),
      });
    }

    const payload = (await res.json()) as OpenRouterResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new OpenRouterError("OpenRouter returned no content", { body: payload });
    }
    let data: T;
    try {
      data = JSON.parse(content) as T;
    } catch (cause) {
      throw new OpenRouterError("OpenRouter content is not valid JSON", {
        cause,
        body: content,
      });
    }
    return {
      data,
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
      costUsd: payload.usage?.cost ?? null,
      model: payload.model ?? p.model,
    };
  }
}
