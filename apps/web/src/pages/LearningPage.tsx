import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getReviewWords,
  listBooks,
  setWordStatus,
  type ReviewWord,
  type UserWordStatus,
} from "../lib/api";
import { levelRangeLabel } from "../lib/levels";
import { LevelBadge } from "../components/badges";
import { LevelRange } from "../components/LevelRange";
import { WordModal } from "../components/WordModal";
import { ExportModal } from "../components/ExportModal";

const LANG = "en";
const PAGE_SIZES = [20, 50, 100];

const SORT_OPTIONS = [
  { value: "added:desc", label: "Recently added" },
  { value: "word:asc", label: "A → Z" },
  { value: "level:asc", label: "Level ↑" },
  { value: "level:desc", label: "Level ↓" },
  { value: "count:desc", label: "Most frequent" },
];

const STATUS_TABS: { value: UserWordStatus; label: string }[] = [
  { value: "learning", label: "Learning" },
  { value: "known", label: "Known" },
  { value: "ignored", label: "Ignored" },
];

// Color + verb label per status (matches the badges / modal). Used for the inline "move
// to" buttons, which always offer the two states a word is not currently in.
const STATUS_META: Record<UserWordStatus, { label: string; cls: string }> = {
  learning: { label: "Learning", cls: "blue" },
  known: { label: "Known", cls: "green" },
  ignored: { label: "Ignore", cls: "gray" },
};
const ALL_STATUSES: UserWordStatus[] = ["learning", "known", "ignored"];

/**
 * The cross-book vocabulary list: words the user has triaged as learning / known / ignored
 * (switchable via tabs). Filter by book and CEFR range, search, sort, move a word to a
 * different state, or open its detail modal.
 */
export function LearningPage() {
  const qc = useQueryClient();

  const [status, setStatus] = useState<UserWordStatus>("learning");
  const [pageSize, setPageSize] = useState(50);
  const [pageIndex, setPageIndex] = useState(0);
  const [bookId, setBookId] = useState("");
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");
  const [sort, setSort] = useState("added:desc");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [openWord, setOpenWord] = useState<ReviewWord | null>(null);
  const [showExport, setShowExport] = useState(false);

  function resetView() {
    setPageIndex(0);
  }

  // Debounce the search box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPageIndex(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const booksQ = useQuery({ queryKey: ["books"], queryFn: listBooks });
  const readyBooks = (booksQ.data ?? []).filter((b) => b.status === "ready");

  const wordsQ = useQuery({
    queryKey: [
      "review",
      { status, pageIndex, pageSize, bookId, minLevel, maxLevel, sort, search },
    ],
    queryFn: () =>
      getReviewWords({
        status,
        limit: pageSize,
        offset: pageIndex * pageSize,
        bookId: bookId || undefined,
        minLevel: minLevel || undefined,
        maxLevel: maxLevel || undefined,
        sort,
        q: search || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const rows = wordsQ.data?.words ?? [];
  const stats = wordsQ.data?.stats;
  const hasMore = rows.length === pageSize;

  const mark = useMutation({
    mutationFn: (v: { word: string; status: UserWordStatus }) =>
      setWordStatus(v.word, v.status, LANG),
    onSuccess: () => {
      // The word leaves the current list, and book review tables reflect the new status.
      qc.invalidateQueries({ queryKey: ["review"] });
      qc.invalidateQueries({ queryKey: ["words"] });
    },
  });

  const levelLabel = levelRangeLabel(minLevel, maxLevel);
  const bookName = bookId ? readyBooks.find((b) => b.id === bookId)?.title : null;

  return (
    <section>
      <div className="page-head">
        <h2>Vocabulary</h2>
        {status === "learning" && (
          <button
            className="btn primary push-right"
            onClick={() => setShowExport(true)}
            disabled={!stats || stats.total === 0}
            title="Export your Learning words as an Anki deck"
          >
            Export to Anki
          </button>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Vocabulary status">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={status === t.value}
            className={`tab${status === t.value ? " active" : ""}`}
            onClick={() => {
              setStatus(t.value);
              resetView();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="toolbar">
        <label className="ctl">
          Book
          <select
            value={bookId}
            onChange={(e) => {
              setBookId(e.target.value);
              resetView();
            }}
          >
            <option value="">All books</option>
            {readyBooks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        </label>

        <LevelRange
          from={minLevel}
          to={maxLevel}
          onChange={({ from, to }) => {
            setMinLevel(from);
            setMaxLevel(to);
            resetView();
          }}
        />

        <label className="ctl">
          Sort
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              resetView();
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <input
          type="search"
          className="search-input"
          placeholder="Search words…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          aria-label="Search words"
        />

        <span className="grow" />

        <label className="ctl">
          Show
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              resetView();
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          per page
        </label>
      </div>

      {stats && (
        <p className="stats-line muted small">
          <strong>{stats.filtered.toLocaleString()}</strong>{" "}
          {levelLabel ? `${levelLabel} ` : ""}
          {status} word{stats.filtered === 1 ? "" : "s"}
          {bookName ? ` in “${bookName}”` : ""}
          {stats.filtered !== stats.total &&
            ` · ${stats.total.toLocaleString()} ${status} total`}
        </p>
      )}

      <div className="table-wrap">
        <table className="words">
          <thead>
            <tr>
              <th>Word</th>
              <th>Level</th>
              <th className="right">Count</th>
              <th>Book</th>
              <th className="right">Triage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.word}>
                <td>
                  {w.bookId ? (
                    <button
                      className="word-link"
                      title={`${w.count}× · ${w.level ?? "no level"}`}
                      onClick={() => setOpenWord(w)}
                    >
                      {w.word}
                    </button>
                  ) : (
                    <span className="word-static">{w.word}</span>
                  )}
                </td>
                <td>
                  <LevelBadge level={w.level} />
                </td>
                <td className="right">
                  <span className="num">{w.count.toLocaleString()}</span>
                </td>
                <td>
                  {w.bookTitle ? (
                    <span className="book-cell">
                      <span className="book-title-cell" title={w.bookTitle}>
                        {w.bookTitle}
                      </span>
                      {w.bookCount > 1 && (
                        <span className="count-chip" title={`In ${w.bookCount} books`}>
                          +{w.bookCount - 1}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="right">
                  <span className="row-actions">
                    {ALL_STATUSES.filter((s) => s !== status).map((s) => (
                      <button
                        key={s}
                        className={`btn ${STATUS_META[s].cls} slim`}
                        disabled={mark.isPending}
                        onClick={() => mark.mutate({ word: w.word, status: s })}
                      >
                        {STATUS_META[s].label}
                      </button>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <p className="muted empty">
            {wordsQ.isLoading
              ? "Loading…"
              : stats && stats.total === 0
                ? `No ${status} words yet. Triage words while reviewing a book.`
                : `No ${status} words match these filters.`}
          </p>
        )}
      </div>

      <div className="pager">
        <button
          className="btn ghost"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
        >
          ← Prev
        </button>
        <span className="muted small">Page {pageIndex + 1}</span>
        <button
          className="btn ghost"
          disabled={!hasMore}
          onClick={() => setPageIndex((p) => p + 1)}
        >
          Next →
        </button>
      </div>

      {openWord && openWord.bookId && (
        <WordModal
          bookId={openWord.bookId}
          word={openWord.word}
          language={LANG}
          onClose={() => setOpenWord(null)}
        />
      )}

      {showExport && (
        <ExportModal books={readyBooks} onClose={() => setShowExport(false)} />
      )}
    </section>
  );
}
