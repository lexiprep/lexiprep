import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import { USER_WORD_STATUSES, type UserWordStatus } from "../db/schema.js";
import {
  buildAnkiDeck,
  countLearningWords,
  deleteUserWord,
  listLearningWords,
  listUserWords,
  upsertUserWords,
  type DeckCard,
  type UserWordItem,
} from "../books/service.js";

const DEFAULT_LANGUAGE = "en";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => HTML_ESCAPE[c]!);
/** One TSV field: no tabs (→ space) or newlines (→ <br>), trimmed. */
const tsvField = (s: string) => s.replace(/\t/g, " ").replace(/\r?\n/g, "<br>").trim();

/**
 * Render cards as an Anki-importable TSV. The `#` directives let modern Anki auto-detect
 * the tab separator + HTML fields and name the columns, so import is one click.
 * Front = the word over its context sentence; Back = the definition (hidden until flip).
 */
function renderAnkiTsv(cards: DeckCard[]): string {
  const header = ["#separator:tab", "#html:true", "#columns:Front\tBack"];
  const lines = cards.map((c) => {
    const front =
      `<div class="lp-word">${escapeHtml(c.word)}</div>` +
      (c.example ? `<div class="lp-ctx">${escapeHtml(c.example)}</div>` : "");
    const back = c.senses.length
      ? c.senses
          .map(
            (s) =>
              `<div>${s.pos ? `<i>${escapeHtml(s.pos)}</i> ` : ""}${escapeHtml(s.gloss)}</div>`,
          )
          .join("")
      : "<div><i>no definition</i></div>";
    return `${tsvField(front)}\t${tsvField(back)}`;
  });
  return [...header, ...lines].join("\n") + "\n";
}

function isStatus(v: unknown): v is UserWordStatus {
  return typeof v === "string" && (USER_WORD_STATUSES as readonly string[]).includes(v);
}

/**
 * The user's vocabulary (`user_words`): list / upsert / remove the words they've
 * classified as learning, known, or ignored. Cross-book, language-scoped. See spec 05.
 */
export async function wordRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/words", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q.status !== undefined && !isStatus(q.status)) {
      reply.code(400);
      return { error: `status must be one of ${USER_WORD_STATUSES.join(", ")}` };
    }
    const words = await listUserWords(request.user!.id, {
      language: q.language,
      status: q.status as UserWordStatus | undefined,
    });
    return { words };
  });

  // The cross-book study list: words of one status (default `learning`), enriched with
  // level + book(s), filterable by book / CEFR range / substring, sortable, paginated.
  app.get("/words/review", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const status = q.status ?? "learning";
    if (!isStatus(status)) {
      reply.code(400);
      return { error: `status must be one of ${USER_WORD_STATUSES.join(", ")}` };
    }
    if (q.bookId !== undefined && !UUID_RE.test(q.bookId)) {
      reply.code(400);
      return { error: "bookId must be a valid id" };
    }
    const opts = {
      language: q.language ?? DEFAULT_LANGUAGE,
      status,
      bookId: q.bookId || undefined,
      minLevel: q.minLevel || undefined,
      maxLevel: q.maxLevel || undefined,
      q: q.q || undefined,
      sort: q.sort || undefined,
      limit: q.limit ? Number(q.limit) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    };
    const [words, stats] = await Promise.all([
      listLearningWords(request.user!.id, opts),
      countLearningWords(request.user!.id, opts),
    ]);
    return { words, stats };
  });

  // Export the learning list as an Anki TSV deck (front = word + context, back = definition).
  // Optional filters: `books` (comma-separated ids) and a `minLevel`/`maxLevel` CEFR range.
  app.get("/words/export", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const bookIds = (q.books ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of bookIds) {
      if (!UUID_RE.test(id)) {
        reply.code(400);
        return { error: "each book id must be valid" };
      }
    }
    const cards = await buildAnkiDeck(request.user!.id, {
      language: q.language ?? DEFAULT_LANGUAGE,
      bookIds,
      minLevel: q.minLevel || undefined,
      maxLevel: q.maxLevel || undefined,
    });
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/tab-separated-values; charset=utf-8")
      .header("content-disposition", `attachment; filename="lexiprep-anki-${date}.tsv"`)
      .send(renderAnkiTsv(cards));
  });

  app.post("/words", async (request, reply) => {
    const body = (request.body ?? {}) as {
      language?: string;
      lemma?: string;
      status?: string;
      items?: { lemma?: string; status?: string }[];
    };
    const language = body.language ?? DEFAULT_LANGUAGE;
    const raw = body.items ?? (body.lemma ? [{ lemma: body.lemma, status: body.status }] : []);
    if (raw.length === 0) {
      reply.code(400);
      return { error: "Provide `items: [{lemma, status}]` or `{lemma, status}`" };
    }

    const items: UserWordItem[] = [];
    for (const it of raw) {
      if (!it.lemma || !it.lemma.trim()) {
        reply.code(400);
        return { error: "Each item needs a non-empty `lemma`" };
      }
      if (!isStatus(it.status)) {
        reply.code(400);
        return { error: `status must be one of ${USER_WORD_STATUSES.join(", ")}` };
      }
      items.push({ lemma: it.lemma, status: it.status });
    }

    await upsertUserWords(request.user!.id, language, items);
    return { ok: true, count: items.length };
  });

  app.delete("/words/:lemma", async (request) => {
    const { lemma } = request.params as { lemma: string };
    const q = request.query as Record<string, string | undefined>;
    await deleteUserWord(request.user!.id, q.language ?? DEFAULT_LANGUAGE, lemma);
    return { ok: true };
  });
}
