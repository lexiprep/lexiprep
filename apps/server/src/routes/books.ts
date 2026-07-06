import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import { env } from "../env.js";
import { getBoss, PROCESS_BOOK_QUEUE } from "../queue/boss.js";
import {
  AI_DEFINITION_SLUG,
  requestAiDefinition,
  triggerAiDefinitions,
} from "../ai/definitionService.js";
import { peek } from "../usage/service.js";
import { retryAfterSeconds } from "../usage/guard.js";
import { db } from "../db/client.js";
import { bookWords } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import {
  addWordNote,
  createBook,
  deleteWordNote,
  finishBookReview,
  getBook,
  getBookWords,
  getBookWordStats,
  getWordDetail,
  listBooks,
  markBookOpened,
  reprocessBook,
  reviewBatch,
  updateBook,
  updateWordNote,
} from "../books/service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function bookRoutes(app: FastifyInstance): Promise<void> {
  // Every route here requires a session.
  app.addHook("preHandler", requireAuth);

  // Upload an EPUB or PDF -> create the book and enqueue processing.
  app.post("/books", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { error: "No file uploaded" };
    }
    if (!/\.(epub|pdf)$/i.test(file.filename)) {
      reply.code(415);
      return { error: "Only .epub and .pdf files are supported" };
    }

    const data = await file.toBuffer();
    const book = await createBook(request.user!.id, {
      filename: file.filename,
      mimeType: file.mimetype,
      data,
    });
    await getBoss().send(PROCESS_BOOK_QUEUE, { bookId: book.id });

    reply.code(202);
    return { book };
  });

  app.get("/books", async (request) => {
    return { books: await listBooks(request.user!.id) };
  });

  // Re-extract an existing book with the latest engine (e.g. after a core release).
  // Reuses the stored file; triage and notes are preserved (see reprocessBook).
  app.post("/books/:id/reprocess", async (request, reply) => {
    const { id } = request.params as { id: string };
    const book = await reprocessBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    await getBoss().send(PROCESS_BOOK_QUEUE, { bookId: book.id });
    reply.code(202);
    return { book };
  });

  app.get("/books/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    // Stamp the open so this book sorts to the top of the list next time.
    await markBookOpened(request.user!.id, book.id);
    return { book };
  });

  // Edit the book's main details (title / author / translator).
  app.patch("/books/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      title?: string;
      author?: string | null;
      translator?: string | null;
    };
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
      reply.code(400);
      return { error: "`title` cannot be empty" };
    }
    let book: Awaited<ReturnType<typeof updateBook>>;
    try {
      book = await updateBook(request.user!.id, id, {
        title: body.title,
        author: body.author,
        translator: body.translator,
      });
    } catch {
      reply.code(400);
      return { error: "`title` cannot be empty" };
    }
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    return { book };
  });

  app.get("/books/:id/words", async (request, reply) => {
    const { id } = request.params as { id: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    const q = request.query as Record<string, string | undefined>;
    const query = {
      includeStopwords: q.includeStopwords === "true",
      includeTriaged: q.includeTriaged === "true",
      status: q.status || undefined,
      minLevel: q.minLevel || undefined,
      maxLevel: q.maxLevel || undefined,
      sort: q.sort || undefined,
      q: q.q || undefined,
      limit: q.limit ? Number(q.limit) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    };
    const [words, stats] = await Promise.all([
      getBookWords(request.user!.id, book, query),
      getBookWordStats(request.user!.id, book, query),
    ]);
    return {
      book: { id: book.id, status: book.status, language: book.language },
      stats,
      words,
    };
  });

  // Word detail for the modal (lazy definition lookup lives here — spec 03).
  app.get("/books/:id/words/:word", async (request, reply) => {
    const { id, word } = request.params as { id: string; word: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    const detail = await getWordDetail(request.user!.id, book, decodeURIComponent(word));
    if (!detail) {
      reply.code(404);
      return { error: "Word not in this book" };
    }
    return detail;
  });

  // The user's own per-book definitions for a word (several allowed; in a book-scoped
  // view they replace the AI/dictionary definition). Rows are addressed by note id.
  app.post("/books/:id/words/:word/notes", async (request, reply) => {
    const { id, word } = request.params as { id: string; word: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    const { note } = (request.body ?? {}) as { note?: string };
    if (typeof note !== "string" || !note.trim()) {
      reply.code(400);
      return { error: "`note` is required" };
    }
    const created = await addWordNote(
      request.user!.id,
      book,
      decodeURIComponent(word),
      note.trim(),
    );
    return { note: created };
  });

  app.put("/books/:id/words/:word/notes/:noteId", async (request, reply) => {
    const { id, noteId } = request.params as { id: string; word: string; noteId: string };
    const book = await getBook(request.user!.id, id);
    if (!book || !UUID_RE.test(noteId)) {
      reply.code(404);
      return { error: "Not found" };
    }
    const { note } = (request.body ?? {}) as { note?: string };
    if (typeof note !== "string" || !note.trim()) {
      reply.code(400);
      return { error: "`note` is required" };
    }
    const found = await updateWordNote(request.user!.id, book, noteId, note.trim());
    if (!found) {
      reply.code(404);
      return { error: "Not found" };
    }
    return { ok: true };
  });

  app.delete("/books/:id/words/:word/notes/:noteId", async (request, reply) => {
    const { id, noteId } = request.params as { id: string; word: string; noteId: string };
    const book = await getBook(request.user!.id, id);
    if (!book || !UUID_RE.test(noteId)) {
      reply.code(404);
      return { error: "Not found" };
    }
    await deleteWordNote(request.user!.id, book, noteId);
    return { ok: true };
  });

  // Resolve a review batch (or finish the whole book) — spec 05.
  app.post("/books/:id/review", async (request, reply) => {
    const { id } = request.params as { id: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    const body = (request.body ?? {}) as {
      finish?: boolean;
      words?: string[];
      learning?: string[];
      rest?: "known" | "ignored";
    };

    if (body.finish) {
      return finishBookReview(request.user!.id, book);
    }
    if (!Array.isArray(body.words)) {
      reply.code(400);
      return { error: "Provide `words: string[]` (the batch) and `learning: string[]`, or `finish: true`" };
    }
    const { transitions, ...result } = await reviewBatch(
      request.user!.id,
      book,
      body.words,
      Array.isArray(body.learning) ? body.learning : [],
      body.rest === "ignored" ? "ignored" : "known",
    );
    // Flagged words just entered `learning` → generate their AI definitions (spec 10).
    await triggerAiDefinitions(request.log, book, transitions);
    return result;
  });

  // Manually request the AI contextual definition for a word (the modal button).
  // Advisory 429 up front for UX; the authoritative reserve+refund lives in the worker.
  app.post("/books/:id/words/:word/ai-definition", async (request, reply) => {
    const { id, word } = request.params as { id: string; word: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    const key = decodeURIComponent(word).trim().toLowerCase();
    const [inBook] = await db
      .select({ id: bookWords.id })
      .from(bookWords)
      .where(
        and(
          eq(bookWords.bookId, book.id),
          sql`coalesce(${bookWords.lemma}, ${bookWords.word}) = ${key}`,
        ),
      )
      .limit(1);
    if (!inBook) {
      reply.code(404);
      return { error: "Word not in this book" };
    }
    if (!env.OPENROUTER_API_KEY) {
      reply.code(503);
      return { error: "AI definitions are not configured" };
    }

    const usage = await peek(request.user!.id, AI_DEFINITION_SLUG);
    if (!usage.allowed) {
      const retryAfter = retryAfterSeconds(usage.windows);
      reply.header("Retry-After", String(retryAfter));
      reply.code(429);
      return { error: "Usage limit reached", slug: AI_DEFINITION_SLUG, retryAfter };
    }

    const result = await requestAiDefinition(book, key, { retryFailed: true });
    if (result === "done") {
      reply.code(409);
      return { error: "AI definition already generated" };
    }
    reply.code(202);
    return { aiDefinition: { status: "pending" } };
  });
}
