import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLookups, listBooks, type LookupRow } from "../lib/api";
import { ago } from "../lib/ago";
import { usePersistentState } from "../lib/usePersistentState";
import { LevelBadge, StatusBadge } from "../components/badges";
import { WordModal } from "../components/WordModal";
import { FilterSheet } from "../components/FilterSheet";

const LANG = "en";
const PAGE_SIZE = 50;

const VIEWS: { value: string; label: string }[] = [
  { value: "", label: "Every word" },
  { value: "new", label: "Not sorted yet" },
  { value: "learning", label: "Learning" },
  { value: "known", label: "Known" },
  { value: "ignored", label: "Ignored" },
];

// Click a column header to sort: first click uses this direction, clicking again flips it.
type SortField = "word" | "level" | "lookups" | "last" | "count";
const SORT_FIRST_DIR: Record<SortField, "asc" | "desc"> = {
  word: "asc",
  level: "asc",
  lookups: "desc",
  last: "desc",
  count: "desc",
};

/**
 * What the dictionary was opened for: every word looked up while reading, with how many
 * times and how recently. Read-only over the lookup log — opening a word here shows its
 * meaning but is not itself a lookup. Words of any status appear, including ones never
 * sorted, which is why this is its own page and not a Vocabulary tab.
 */
export function LookupsPage() {
  const qc = useQueryClient();

  const k = (name: string) => `lexiprep.lookups.${name}`;
  const [pageIndex, setPageIndex] = useState(0);
  const [sort, setSort] = usePersistentState(k("sort"), "lookups:desc");
  const [bookId, setBookId] = usePersistentState(k("bookId"), "");
  const [view, setView] = usePersistentState(k("view"), "");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [openWord, setOpenWord] = useState<LookupRow | null>(null);

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
  // A remembered book that has since been deleted must not leave the list silently empty.
  const scopedBook = bookId ? readyBooks.find((b) => b.id === bookId) : undefined;
  const activeBookId = scopedBook?.id ?? "";

  const lookupsQ = useQuery({
    queryKey: ["lookups", { pageIndex, sort, bookId: activeBookId, view, search }],
    queryFn: () =>
      getLookups({
        limit: PAGE_SIZE,
        offset: pageIndex * PAGE_SIZE,
        sort,
        bookId: activeBookId || undefined,
        status: view || undefined,
        q: search || undefined,
        language: LANG,
      }),
    enabled: !bookId || booksQ.isSuccess,
    placeholderData: keepPreviousData,
  });
  const rows = lookupsQ.data?.words ?? [];
  const stats = lookupsQ.data?.stats;
  const hasMore = rows.length === PAGE_SIZE;
  // The meter is read against the most looked-up word on screen.
  const top = rows.reduce((m, r) => Math.max(m, r.lookups), 1);
  const filtered = Boolean(activeBookId || view || search);

  const [sortField, sortDir] = sort.split(":");
  function toggleSort(field: SortField) {
    setSort((cur) => {
      const [f, d] = cur.split(":");
      return `${field}:${f === field ? (d === "asc" ? "desc" : "asc") : SORT_FIRST_DIR[field]}`;
    });
    setPageIndex(0);
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

  const appliedFilters = [
    scopedBook?.title,
    view && VIEWS.find((v) => v.value === view)?.label,
    search && `“${search}”`,
  ].filter((label): label is string => Boolean(label));

  return (
    <section>
      <div className="book-header">
        <h2>Lookups</h2>
        <p className="muted small">
          {stats && stats.lookups > 0
            ? `${stats.lookups.toLocaleString()} ${
                stats.lookups === 1 ? "lookup" : "lookups"
              } of ${stats.words.toLocaleString()} ${stats.words === 1 ? "word" : "words"}${
                filtered ? " in this view" : " while reading"
              }`
            : "The words you open in a book's dictionary while reading."}
        </p>
      </div>

      <FilterSheet applied={appliedFilters}>
        <label className="ctl">
          Book
          <select
            value={activeBookId}
            onChange={(e) => {
              setBookId(e.target.value);
              setPageIndex(0);
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

        <label className="ctl">
          Show
          <select
            value={view}
            onChange={(e) => {
              setView(e.target.value);
              setPageIndex(0);
            }}
          >
            {VIEWS.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
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
      </FilterSheet>

      <div className="table-wrap">
        <table className="words lookups">
          <thead>
            <tr>
              {sortableTh("word", "Word")}
              {sortableTh("lookups", "Looked up")}
              {sortableTh("last", "Last")}
              {sortableTh("level", "Level")}
              <th className="col-status">Status</th>
              {sortableTh("count", scopedBook ? "In book" : "In books", true)}
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.word}>
                <td className="col-word">
                  {w.bookId ? (
                    <button className="word-link" onClick={() => setOpenWord(w)}>
                      {w.word}
                    </button>
                  ) : (
                    <span
                      className="word-static"
                      title="No book in your library contains this word any more"
                    >
                      {w.word}
                    </span>
                  )}
                </td>
                <td className="col-lookups">
                  <span
                    className="lookup-meter"
                    style={{ "--share": w.lookups / top } as CSSProperties}
                    title={`Looked up ${w.lookups} ${w.lookups === 1 ? "time" : "times"}`}
                  >
                    <span className="num">{w.lookups.toLocaleString()}</span>
                    <span className="lookup-bar" aria-hidden="true" />
                  </span>
                </td>
                <td className="col-last">
                  <time dateTime={w.lastAt} title={new Date(w.lastAt).toLocaleString()}>
                    {ago(w.lastAt)}
                  </time>
                </td>
                <td className="col-level">
                  <LevelBadge level={w.level} />
                </td>
                <td className="col-status">
                  <StatusBadge status={w.status} />
                </td>
                <td className="col-count right">
                  <span className="num">{w.count > 0 ? `${w.count.toLocaleString()}×` : "—"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 &&
          (lookupsQ.isLoading || lookupsQ.isPending ? (
            <p className="muted empty">Loading…</p>
          ) : filtered ? (
            <p className="muted empty">No lookups match these filters.</p>
          ) : (
            <p className="muted empty">
              Nothing looked up yet. Open a <Link to="/">book</Link>, choose Dictionary, and
              every word you open while reading is counted here.
            </p>
          ))}
      </div>

      {(pageIndex > 0 || hasMore) && (
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
      )}

      {openWord && openWord.bookId && (
        <WordModal
          bookId={openWord.bookId}
          word={openWord.word}
          language={LANG}
          source="book"
          bookScoped={Boolean(scopedBook)}
          initial={{
            word: openWord.word,
            level: openWord.level,
            // Scoped to a book the row's count is that book's own; otherwise it is the
            // library-wide total and the header chip waits for the detail request.
            ...(scopedBook
              ? { count: openWord.count }
              : { libraryCount: openWord.count, bookCount: openWord.bookCount }),
            status: openWord.status,
            example: openWord.example,
            bookTitle: openWord.bookTitle,
          }}
          onStatusChange={() => qc.invalidateQueries({ queryKey: ["lookups"] })}
          onClose={() => setOpenWord(null)}
        />
      )}
    </section>
  );
}
