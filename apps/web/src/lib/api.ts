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

export type AiDefinitionStatus = "pending" | "done" | "failed";

/** The AI contextual definition for this word in this book (job state + senses). */
export interface AiDefinition {
  status: AiDefinitionStatus;
  /** The generated meanings; set once `status` is `done`. */
  senses: WordSense[] | null;
  error: string | null;
}

/** One of the user's own per-book definitions (several allowed per word). */
export interface WordNoteItem {
  id: string;
  note: string;
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
  /** The user's own per-book definitions; book-scoped they replace AI/dictionary. */
  notes: WordNoteItem[];
  aiDefinition: AiDefinition | null;
  /** False when the server has no OpenRouter key — hide the AI UI entirely. */
  aiDefinitionEnabled: boolean;
}

export interface UserWord {
  lemma: string;
  language: string;
  status: UserWordStatus;
  updatedAt: string;
}

/**
 * Error thrown for any non-2xx response. Carries the HTTP `status` (and, for usage
 * limits, the `slug` + `retryAfter`) so callers can react specifically — e.g. treat a
 * 429 as "limit reached". Extends Error, so existing `err.message` handling is unchanged.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly slug?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
    let slug: string | undefined;
    let retryAfter: number | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        slug?: string;
        retryAfter?: number;
      };
      if (body?.error) message = body.error;
      slug = body?.slug;
      retryAfter = body?.retryAfter;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, slug, retryAfter);
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

export const addWordNote = (id: string, word: string, note: string) =>
  request<{ note: WordNoteItem }>(
    `/api/books/${id}/words/${encodeURIComponent(word)}/notes`,
    { method: "POST", body: JSON.stringify({ note }) },
  ).then((r) => r.note);

export const updateWordNote = (id: string, word: string, noteId: string, note: string) =>
  request<{ ok: true }>(
    `/api/books/${id}/words/${encodeURIComponent(word)}/notes/${noteId}`,
    { method: "PUT", body: JSON.stringify({ note }) },
  );

export const deleteWordNote = (id: string, word: string, noteId: string) =>
  request<{ ok: true }>(
    `/api/books/${id}/words/${encodeURIComponent(word)}/notes/${noteId}`,
    { method: "DELETE" },
  );

/**
 * Request the AI contextual definition for a word in a book (202 → poll the word
 * detail). 429 = usage limit (ApiError carries `retryAfter`); 409 = already generated.
 */
export const generateAiDefinition = (id: string, word: string) =>
  request<{ aiDefinition: AiDefinition }>(
    `/api/books/${id}/words/${encodeURIComponent(word)}/ai-definition`,
    { method: "POST" },
  );

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
  /** Book context: lets the server auto-generate an AI definition on `learning`. */
  bookId?: string,
) =>
  request<{ ok: true; count: number }>("/api/words", {
    method: "POST",
    body: JSON.stringify({ language, source, bookId, items: [{ lemma, status }] }),
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
  /** Representative book the word comes from — used to attach per-book definitions. */
  bookId: string | null;
  bookTitle: string | null;
  /** The user's own definitions for that book (several allowed; replace the rest). */
  notes: WordNoteItem[];
  /** AI contextual senses generated for that book (replace the dictionary), or null. */
  aiSenses: WordSense[] | null;
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

// ── Usage limits / paid features (spec 13) ─────────────────────────────────────

/** Slugs mirror the server registry (`apps/server/src/usage/features.ts`). */
export type PaidFeatureSlug = "ai-word-definition-from-context";
export type UsageWindow = "minute" | "hour" | "day" | "month";

export interface UsageWindowInfo {
  window: UsageWindow;
  used: number;
  max: number;
  remaining: number;
  /** When this window next admits again; null when nothing counted. */
  resetAt: string | null;
}

/** Result of a usage check: `allowed` false = the limit is hit. */
export interface UsageCheck {
  allowed: boolean;
  windows: UsageWindowInfo[];
}

export interface FeatureCatalogItem {
  slug: PaidFeatureSlug;
  label: string;
  description: string;
  limits: { window: UsageWindow; max: number }[];
  usage: UsageCheck;
}

/** (a) The catalogue of paid features + this user's live usage. */
export const getFeatures = () =>
  request<{ features: FeatureCatalogItem[] }>("/api/usage/features").then((r) => r.features);

/** (b) Advisory check: does the user still have usage for this feature? Does not consume. */
export const checkUsage = (slug: PaidFeatureSlug) =>
  request<UsageCheck>("/api/usage/check", {
    method: "POST",
    body: JSON.stringify({ slug }),
  });
