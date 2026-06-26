// Thin typed client over the lexiprep server API. Same-origin in dev (Vite proxies
// /api to the server), so cookies flow without CORS.

export type UserWordStatus = "learning" | "known" | "ignored";
export type BookStatus = "uploaded" | "processing" | "ready" | "failed";

export interface Book {
  id: string;
  title: string;
  author: string | null;
  translator: string | null;
  language: string;
  status: BookStatus;
  error: string | null;
  chapterCount: number | null;
  tokenCount: number | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface BookWordRow {
  /** Base form (lemma) — conjugations are grouped under it; counts are summed. */
  word: string;
  count: number;
  level: string | null;
  example: string | null;
  status: UserWordStatus | null;
}

export interface BookWordStats {
  /** Distinct words (lemmas) in the book. */
  total: number;
  /** Still to review (untriaged). */
  remaining: number;
  /** Matching the current filter (level etc.). */
  filtered: number;
  /** Untriaged words with no CEFR level (names / rare words) — the "first stage" junk. */
  unleveled: number;
}

export interface WordForm {
  word: string;
  count: number;
  example: string | null;
}

export interface WordSense {
  pos: string;
  gloss: string;
  example?: string;
}

export interface WordDetail {
  word: string;
  lemma: string | null;
  count: number;
  level: string | null;
  example: string | null;
  status: UserWordStatus | null;
  forms: WordForm[];
  definition: WordSense[] | null;
  /** The user's own per-book note for this word. */
  note: string | null;
}

export interface UserWord {
  lemma: string;
  language: string;
  status: UserWordStatus;
  updatedAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body && typeof init.body === "string"
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== false) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ── Books ────────────────────────────────────────────────────────────────────

export const listBooks = () =>
  request<{ books: Book[] }>("/api/books").then((r) => r.books);

export const getBook = (id: string) =>
  request<{ book: Book }>(`/api/books/${id}`).then((r) => r.book);

export function uploadBook(file: File): Promise<Book> {
  const form = new FormData();
  form.append("file", file);
  return request<{ book: Book }>("/api/books", { method: "POST", body: form }).then(
    (r) => r.book,
  );
}

export interface WordsParams {
  limit: number;
  offset: number;
  sort?: string;
  minLevel?: string;
  maxLevel?: string;
  /** "" = to review (untriaged); "all" | "known" | "learning" | "ignored". */
  status?: string;
  includeStopwords?: boolean;
}

export const getBookWords = (id: string, params: WordsParams) =>
  request<{
    book: { id: string; status: BookStatus; language: string };
    stats: BookWordStats;
    words: BookWordRow[];
  }>(`/api/books/${id}/words${qs({ ...params })}`);

export const getWordDetail = (id: string, word: string) =>
  request<WordDetail>(`/api/books/${id}/words/${encodeURIComponent(word)}`);

export const setWordNote = (id: string, word: string, note: string) =>
  request<{ ok: true }>(`/api/books/${id}/words/${encodeURIComponent(word)}/note`, {
    method: "PUT",
    body: JSON.stringify({ note }),
  });

export const deleteWordNote = (id: string, word: string) =>
  request<{ ok: true }>(`/api/books/${id}/words/${encodeURIComponent(word)}/note`, {
    method: "DELETE",
  });

export const reviewBatch = (
  id: string,
  words: string[],
  learning: string[],
  rest: "known" | "ignored" = "known",
) =>
  request<{ learning: number; resolved: number }>(`/api/books/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ words, learning, rest }),
  });

export const finishBook = (id: string) =>
  request<{ known: number }>(`/api/books/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ finish: true }),
  });

// ── User vocabulary ──────────────────────────────────────────────────────────

export const listUserWords = (status?: UserWordStatus, language = "en") =>
  request<{ words: UserWord[] }>(`/api/words${qs({ status, language })}`).then(
    (r) => r.words,
  );

/** A row in the cross-book study list (`GET /api/words/review`). */
export interface ReviewWord {
  /** Base form (lemma). */
  word: string;
  status: UserWordStatus;
  level: string | null;
  /** Total occurrences across the matched books (or the single filtered book). */
  count: number;
  /** How many of the user's books this word appears in. */
  bookCount: number;
  /** A representative book — the one where it occurs most. Null if in no book. */
  bookTitle: string | null;
  bookId: string | null;
  example: string | null;
  updatedAt: string;
}

export interface ReviewStats {
  /** All the user's words of this status (the full list). */
  total: number;
  /** Matching the current filters. */
  filtered: number;
}

export interface ReviewWordsParams {
  limit: number;
  offset: number;
  status?: UserWordStatus;
  bookId?: string;
  minLevel?: string;
  maxLevel?: string;
  q?: string;
  sort?: string;
  language?: string;
}

export const getReviewWords = (params: ReviewWordsParams) =>
  request<{ words: ReviewWord[]; stats: ReviewStats }>(
    `/api/words/review${qs({ ...params })}`,
  );

export const setWordStatus = (
  lemma: string,
  status: UserWordStatus,
  language = "en",
) =>
  request<{ ok: true; count: number }>("/api/words", {
    method: "POST",
    body: JSON.stringify({ language, items: [{ lemma, status }] }),
  });

export const clearWordStatus = (lemma: string, language = "en") =>
  request<{ ok: true }>(`/api/words/${encodeURIComponent(lemma)}${qs({ language })}`, {
    method: "DELETE",
  });

// ── Anki export ────────────────────────────────────────────────────────────────

export interface ExportParams {
  /** Restrict to learning words occurring in these books (empty = all books). */
  books?: string[];
  minLevel?: string;
  maxLevel?: string;
  language?: string;
}

/** URL for the Anki TSV download (GET, same-origin so the session cookie flows). */
export function exportDeckUrl(p: ExportParams): string {
  return `/api/words/export${qs({
    books: p.books && p.books.length > 0 ? p.books.join(",") : undefined,
    minLevel: p.minLevel,
    maxLevel: p.maxLevel,
    language: p.language,
  })}`;
}
