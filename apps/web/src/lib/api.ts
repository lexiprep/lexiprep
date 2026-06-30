// Thin typed client over the lexiprep server API. Same-origin in dev (Vite proxies
// /api to the server), so cookies flow without CORS.

export type UserWordStatus = "learning" | "known" | "ignored";
export type BookStatus = "uploaded" | "processing" | "ready" | "failed";

/**
 * Which UI surface a status change came from. Only `"learning"` (the Learning page) lets a
 * learning→known count as a "learned" word; `"book"` (a book's review page) is triage — a
 * learning→known there is a correction, not a learned word. See the Learned series on /stats.
 */
export type WordEventSource = "book" | "learning";

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
  /** Distinct words (lemmas) in the book, stopwords hidden. */
  uniqueWords: number;
  /** Of those, still untriaged (not yet sorted). */
  wordsToReview: number;
  reviewedAt: string | null;
  lastOpenedAt: string | null;
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

/** Re-extract a book with the latest engine. Triage and notes are preserved server-side. */
export const reprocessBook = (id: string) =>
  request<{ book: Book }>(`/api/books/${id}/reprocess`, { method: "POST" }).then(
    (r) => r.book,
  );

/** Editable book details. Omit a field to leave it unchanged; "" clears author/translator. */
export interface BookDetailsInput {
  title?: string;
  author?: string | null;
  translator?: string | null;
}

export const updateBook = (id: string, details: BookDetailsInput) =>
  request<{ book: Book }>(`/api/books/${id}`, {
    method: "PATCH",
    body: JSON.stringify(details),
  }).then((r) => r.book);

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

// ── Vocabulary stats ─────────────────────────────────────────────────────────

export interface VocabCounts {
  learning: number;
  known: number;
  ignored: number;
}

/** Per-status vocabulary counts for the tab badges (0-occurrence words excluded). */
export const getVocabCounts = (language = "en") =>
  request<VocabCounts>(`/api/words/counts${qs({ language })}`);

export type Granularity = "day" | "week" | "month";

export interface TimeseriesPoint {
  /** Bucket start, YYYY-MM-DD. */
  period: string;
  /** Words added (first triaged) in this bucket, by current status. */
  learning: number;
  known: number;
  /** Words learned (moved learning → known from the Learning page) in this bucket. */
  learned: number;
}

export interface VocabularyTimeseries {
  granularity: Granularity;
  /** Totals accumulated before the range start (so cumulative charts start from the truth). */
  baseline: { learning: number; known: number; learned: number };
  buckets: TimeseriesPoint[];
}

export interface TimeseriesParams {
  /** YYYY-MM-DD (inclusive). */
  from: string;
  to: string;
  granularity: Granularity;
  language?: string;
}

export const getVocabTimeseries = (p: TimeseriesParams) =>
  request<VocabularyTimeseries>(`/api/words/stats/timeseries${qs({ ...p })}`);

export const setWordStatus = (
  lemma: string,
  status: UserWordStatus,
  language: string,
  /** Where the change came from — drives the "learned" series. See {@link WordEventSource}. */
  source: WordEventSource,
) =>
  request<{ ok: true; count: number }>("/api/words", {
    method: "POST",
    body: JSON.stringify({ language, source, items: [{ lemma, status }] }),
  });

export const clearWordStatus = (
  lemma: string,
  language: string,
  source: WordEventSource,
) =>
  request<{ ok: true }>(
    `/api/words/${encodeURIComponent(lemma)}${qs({ language, source })}`,
    { method: "DELETE" },
  );

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

// ── Card review (spaced repetition) ──────────────────────────────────────────

export type SrsState = "new" | "learning" | "review" | "relearning";

/** Button labels showing the interval each grade would schedule next (e.g. "1d", "10m"). */
export interface GradePreview {
  again: string;
  hard: string;
  good: string;
  easy: string;
}

/** One card in a review session — the word plus everything needed to study and grade it. */
export interface ReviewCard {
  /** Base form (lemma) — the grade keys on this. */
  lemma: string;
  /** A representative surface form to show on the card front. */
  word: string;
  example: string | null;
  level: string | null;
  /** Cached senses (POS + gloss + example); null if the dictionary has none. */
  definition: WordSense[] | null;
  /** Representative book the word comes from — used to attach a per-book note. */
  bookId: string | null;
  bookTitle: string | null;
  /** The user's own note (custom meaning) for that book, or null. */
  note: string | null;
  /** Every surface form of the lemma — used to bold the word in the context sentence. */
  forms: string[];
  state: SrsState;
  /** True for cards pulled from the new-card budget (never reviewed before). */
  isNew: boolean;
  preview: GradePreview;
}

export interface ReviewSession {
  cards: ReviewCard[];
  counts: {
    /** New cards included in this session. */
    new: number;
    /** Due cards included in this session. */
    due: number;
    /** Cards still queued in this session. */
    remaining: number;
    /** Full due backlog (may exceed `due` when capped by maxPerDay). */
    totalDue: number;
    /** New cards already introduced today; the day's new budget is `newPerDay − this`. */
    newDoneToday: number;
  };
  /** Consecutive local-calendar days reviewed, for the header. */
  streak: number;
}

export interface GradeResult {
  /** True if the card re-shows this session (sub-day learning/relearning step). */
  stays: boolean;
  /** True if grading auto-graduated the word to `known`. */
  graduated: boolean;
  card: {
    state: string;
    intervalDays: number;
    /** Next due timestamp (ISO), or null while in a sub-day step. */
    due: string | null;
    preview: GradePreview;
  };
}

/**
 * Headline SRS stats for the Stats page.
 *
 * NOTE: named `ReviewStatsSummary` (not `ReviewStats`) to avoid colliding with the
 * existing study-list {@link ReviewStats} (`{ total, filtered }`). This is the shape
 * returned by {@link getReviewStats}.
 */
export interface ReviewStatsSummary {
  dayStreak: number;
  reviewedToday: number;
  reviewedAllTime: number;
  /** Mean elapsed days between reviews, or null with too little history. */
  avgDaysBetween: number | null;
}

export interface ReviewTimeseries {
  granularity: string;
  buckets: {
    /** Bucket start, YYYY-MM-DD. */
    period: string;
    reviews: number;
    again: number;
    hard: number;
    good: number;
    easy: number;
  }[];
}

export interface UserSettings {
  newPerDay: number;
  maxPerDay: number;
  autoGraduateKnown: boolean;
  /** IANA timezone for the day boundary; null → UTC. */
  timezone: string | null;
}

export const getReviewSession = (params: {
  bookId?: string;
  minLevel?: string;
  maxLevel?: string;
  newPerDay?: number;
  maxPerDay?: number;
}) => request<ReviewSession>(`/api/review/session${qs({ ...params })}`);

export const gradeCard = (lemma: string, grade: 1 | 2 | 3 | 4) =>
  request<GradeResult>("/api/review/grade", {
    method: "POST",
    body: JSON.stringify({ lemma, grade }),
  });

export const getReviewStats = () =>
  request<ReviewStatsSummary>("/api/review/stats");

export const getReviewTimeseries = (params: {
  from?: string;
  to?: string;
  granularity?: string;
}) => request<ReviewTimeseries>(`/api/review/stats/timeseries${qs({ ...params })}`);

export const getSettings = () => request<UserSettings>("/api/settings");

export const updateSettings = (patch: Partial<UserSettings>) =>
  request<UserSettings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
