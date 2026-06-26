import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import { getBoss, PROCESS_BOOK_QUEUE } from "../queue/boss.js";
import {
  createBook,
  deleteWordNote,
  finishBookReview,
  getBook,
  getBookWords,
  getBookWordStats,
  getWordDetail,
  listBooks,
  reviewBatch,
  setWordNote,
} from "../books/service.js";

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

  app.get("/books/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const book = await getBook(request.user!.id, id);
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

  // Per-book user note for a word (a meaning specific to this book's context).
  app.put("/books/:id/words/:word/note", async (request, reply) => {
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
    await setWordNote(request.user!.id, book, decodeURIComponent(word), note.trim());
    return { ok: true };
  });

  app.delete("/books/:id/words/:word/note", async (request, reply) => {
    const { id, word } = request.params as { id: string; word: string };
    const book = await getBook(request.user!.id, id);
    if (!book) {
      reply.code(404);
      return { error: "Not found" };
    }
    await deleteWordNote(request.user!.id, book, decodeURIComponent(word));
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
    return reviewBatch(
      request.user!.id,
      book,
      body.words,
      Array.isArray(body.learning) ? body.learning : [],
      body.rest === "ignored" ? "ignored" : "known",
    );
  });
}
