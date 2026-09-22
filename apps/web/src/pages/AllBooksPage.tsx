import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getLibraryWords,
  setWordStatus,
  type LibraryWordRow,
  type UserWordStatus,
} from "../lib/api";
import { levelRangeLabel } from "../lib/levels";
import { usePersistentState } from "../lib/usePersistentState";
import { LevelBadge, StatusBadge } from "../components/badges";
import { LevelRange } from "../components/LevelRange";
import { WordModal } from "../components/WordModal";
import { FilterSheet } from "../components/FilterSheet";

const LANG = "en";
const PAGE_SIZES = [10, 20, 50, 100];

// Per-row triage, same three actions (and colors) as a book's review table.
const TRIAGE: { status: UserWordStatus; label: string; cls: string }[] = [
  { status: "learning", label: "Learning", cls: "blue" },
  { status: "known", label: "Known", cls: "green" },
  { status: "ignored", label: "Ignore", cls: "gray" },
];

// Click a column header to sort: first click uses this direction, clicking again flips it.
type SortField = "word" | "level" | "count" | "books";
const SORT_FIRST_DIR: Record<SortField, "asc" | "desc"> = {
  word: "asc",
  level: "asc",
  count: "desc",
  books: "desc",
};

/**
 * The library as one frequency list: every word of every book, counts summed, so the
 * words worth learning first surface across the whole shelf instead of one book at a
 * time. Triage works exactly as on a book page — `user_words` is cross-book already, so
 * marking a word here resolves it everywhere — but the per-book review machinery (fixed
 * batches, the unleveled gate, "Finish book") deliberately stays on the book page.
 */
export function AllBooksPage() {
  const qc = useQueryClient();

  const k = (name: string) => `lexiprep.library.${name}`;
  const [pageSize, setPageSize] = usePersistentState(k("pageSize"), 50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = usePersistentState(k("sort"), "count:desc");
  const [minLevel, setMinLevel] = usePersistentState(k("minLevel"), "");
  const [maxLevel, setMaxLevel] = usePersistentState(k("maxLevel"), "");
  // "" = to review (untriaged, default); "all" / known / learning / ignored otherwise.
  const [view, setView] = usePersistentState(k("view"), "");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [openWord, setOpenWord] = useState<LibraryWordRow | null>(null);

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

  const wordsQ = useQuery({
    queryKey: [
      "library-words",
      { pageIndex, pageSize, sort, minLevel, maxLevel, view, search },
    ],
    queryFn: () =>
      getLibraryWords({
        limit: pageSize,
        offset: pageIndex * pageSize,
        sort,
        minLevel: minLevel || undefined,
        maxLevel: maxLevel || undefined,
        status: view || undefined,
        q: search || undefined,
        language: LANG,
      }),
    placeholderData: keepPreviousData,
  });
  const rows = wordsQ.data?.words ?? [];
  const stats = wordsQ.data?.stats;
  const hasMore = rows.length === pageSize;

  // Words triaged in the loaded page are hidden immediately, so the list never waits on
  // the request and nothing new slides in under the cursor. Cleared when the query changes.
  const [triaged, setTriaged] = useState<Set<string>>(new Set());
  useEffect(() => {
    setTriaged(new Set());
  }, [pageIndex, pageSize, sort, minLevel, maxLevel, view, search]);
  const visibleRows = rows.filter((r) => !triaged.has(r.word));

  const mark = useMutation({
    // Triage, not study: a learning→known here is a correction, so it's "book"-sourced
    // and never inflates the Learned series (same as a book's review table).
    mutationFn: (v: { word: string; status: UserWordStatus }) =>
      setWordStatus(v.word, v.status, LANG, "book"),
    onMutate: (v) => setTriaged((prev) => new Set(prev).add(v.word)),
    onSuccess: () => {
      // The book lists and the vocabulary page both change; this page's own list stays
      // frozen so the batch you're working doesn't reshuffle mid-pass.
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["library-stats"] });
      qc.invalidateQueries({ queryKey: ["review"] });
      qc.invalidateQueries({ queryKey: ["vocab-counts"] });
    },
    onError: (err, v) => {
      setTriaged((prev) => {
        const next = new Set(prev);
        next.delete(v.word);
        return next;
      });
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : `Couldn't mark “${v.word}” as ${v.status}.`,
      );
    },
  });

  const [sortField, sortDir] = sort.split(":");
  function toggleSort(field: SortField) {
    setSort((cur) => {
      const [f, d] = cur.split(":");
      return `${field}:${f === field ? (d === "asc" ? "desc" : "asc") : SORT_FIRST_DIR[field]}`;
    });
    resetView();
  }
  // `col-<field>` is what the phone layout keys off (see styles.css).
  const sortableTh = (field: SortField, label: string, right = false) => (
    <th
      className={`col-${field} sortable${right ? " right" : ""}`}
      aria-sort={
        sortField === field ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
      onClick={() => toggleSort(field)}
    >
      {label}
      {sortField === field && (
        <span className="sort-ind">{sortDir === "asc" ? " ▲" : " ▼"}</span>
      )}
    </th>
  );

  const levelLabel = levelRangeLabel(minLevel, maxLevel);
  const appliedFilters = [
    view && (view === "all" ? "All words" : view.charAt(0).toUpperCase() + view.slice(1)),
    levelLabel && `Level ${levelLabel}`,
    search && `“${search}”`,
    pageSize !== 50 && `${pageSize} per page`,
  ].filter((label): label is string => Boolean(label));

  return (
    <section>
      <div className="page-head">
        <Link to="/" className="linkbtn">
          ← Books
        </Link>
      </div>

      <div className="book-header">
        <h2>All books</h2>
        <p className="muted small book-sub">
          {stats && (
            <span>
              {stats.total.toLocaleString()} words across your library
            </span>
          )}
        </p>
      </div>

      <FilterSheet applied={appliedFilters}>
        <label className="ctl">
          <span className="ctl-name">Show</span>
          <span className="ctl-field">
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
            <span>per page</span>
          </span>
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
          View
          <select
            value={view}
            onChange={(e) => {
              setView(e.target.value);
              resetView();
            }}
          >
            <option value="">To review</option>
            <option value="all">All words</option>
            <option value="known">Known</option>
            <option value="learning">Learning</option>
            <option value="ignored">Ignored</option>
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
      </FilterSheet>

      {stats && (
        <p className="stats-line muted small">
          <strong>{stats.filtered.toLocaleString()}</strong>{" "}
          {view === "" ? "words to review" : "words"}
          {/* Only worth repeating the untriaged total once a filter has narrowed it. */}
          {view === "" && stats.filtered !== stats.remaining
            ? ` · ${stats.remaining.toLocaleString()} to review in all`
            : ""}
        </p>
      )}

      <div className="table-wrap">
        <table className="words">
          <thead>
            <tr>
              {sortableTh("word", "Word")}
              {sortableTh("level", "Level")}
              {sortableTh("count", "Count", true)}
              {sortableTh("books", "In books", true)}
              {view !== "" && <th className="col-status">Status</th>}
              <th className="col-triage right">Triage</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((w) => (
              <tr key={w.word}>
                <td className="col-word">
                  {w.bookId ? (
                    <button
                      className="word-link"
                      title={`${w.count}× in ${w.bookCount} book${
                        w.bookCount === 1 ? "" : "s"
                      } · ${w.level ?? "no level"}`}
                      onClick={() => setOpenWord(w)}
                    >
                      {w.word}
                    </button>
                  ) : (
                    <span className="word-static">{w.word}</span>
                  )}
                </td>
                <td className="col-level">
                  <LevelBadge level={w.level} />
                </td>
                <td className="col-count right">
                  <span className="num">{w.count.toLocaleString()}</span>
                </td>
                <td className="col-books right">
                  <span className="num">{w.bookCount.toLocaleString()}</span>
                </td>
                {view !== "" && (
                  <td className="col-status">
                    <StatusBadge status={w.status} />
                  </td>
                )}
                <td className="col-triage right">
                  <span className="row-actions">
                    {TRIAGE.map((t) => {
                      const active = w.status === t.status;
                      return (
                        <button
                          key={t.status}
                          className={`btn ${t.cls} slim${active ? " active" : ""}`}
                          disabled={active}
                          onClick={() => mark.mutate({ word: w.word, status: t.status })}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {visibleRows.length === 0 && (
          <p className="muted empty">
            {wordsQ.isLoading
              ? "Loading…"
              : stats && stats.total === 0
                ? "No words yet. Upload a book and it'll show up here."
                : rows.length > 0
                  ? "Batch done — load the next page."
                  : "No words match these filters."}
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
          source="book"
          initial={{
            word: openWord.word,
            level: openWord.level,
            // The row's count is the library-wide total; this book's own share comes with
            // the detail request, so the header chip waits for it rather than flipping.
            libraryCount: openWord.count,
            bookCount: openWord.bookCount,
            status: openWord.status,
            example: openWord.example,
            bookTitle: openWord.bookTitle,
          }}
          onStatusChange={(word) => setTriaged((prev) => new Set(prev).add(word))}
          onClose={() => setOpenWord(null)}
        />
      )}
    </section>
  );
}
