import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  finishBook,
  getBook,
  getBookWords,
  reviewBatch,
  setWordStatus,
  type BookWordRow,
  type UserWordStatus,
} from "../lib/api";
import { levelRangeLabel } from "../lib/levels";
import { usePersistentState } from "../lib/usePersistentState";
import { LevelBadge, StatusBadge } from "../components/badges";
import { LevelRange } from "../components/LevelRange";
import { WordModal } from "../components/WordModal";
import { ConfirmDialog } from "../components/ConfirmDialog";

const PAGE_SIZES = [10, 20, 50, 100];

// Per-row triage buttons (replaces the old flag-as-new checkbox + batch actions).
const TRIAGE: { status: UserWordStatus; label: string; cls: string }[] = [
  { status: "learning", label: "Learning", cls: "blue" },
  { status: "known", label: "Known", cls: "green" },
  { status: "ignored", label: "Ignore", cls: "gray" },
];

export function BookPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();

  // Filters/sort/page-size are remembered per book (keyed by id), so reopening a book
  // resumes its last view. pageIndex stays ephemeral — batches shift as words are triaged,
  // so a saved index would often land on a stale batch.
  const k = (name: string) => (id ? `lexiprep.book.${id}.${name}` : null);
  const [pageSize, setPageSize] = usePersistentState(k("pageSize"), 50);
  const [pageIndex, setPageIndex] = useState(0);
  const [sorting, setSorting] = usePersistentState<SortingState>(k("sort"), [
    { id: "count", desc: true },
  ]);
  const [minLevel, setMinLevel] = usePersistentState(k("minLevel"), "");
  const [maxLevel, setMaxLevel] = usePersistentState(k("maxLevel"), "");
  // "" = to review (untriaged, default); "all" / known / learning / ignored otherwise.
  const [view, setView] = usePersistentState(k("view"), "");
  // Words triaged within the current loaded batch — hidden locally so the batch shrinks
  // as you work it, without pulling in new words (the user reviews a fixed batch).
  const [triaged, setTriaged] = useState<Set<string>>(new Set());
  const [openWord, setOpenWord] = useState<BookWordRow | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);

  function resetView() {
    setPageIndex(0);
    setTriaged(new Set());
  }

  const bookQ = useQuery({
    queryKey: ["book", id],
    queryFn: () => getBook(id),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "uploaded" || s === "processing" ? 1500 : false;
    },
  });
  const book = bookQ.data;
  const ready = book?.status === "ready";

  const sortParam =
    sorting.map((s) => `${s.id}:${s.desc ? "desc" : "asc"}`).join(",") || undefined;

  const wordsQ = useQuery({
    queryKey: ["words", id, { pageIndex, pageSize, sortParam, minLevel, maxLevel, view }],
    queryFn: () =>
      getBookWords(id, {
        limit: pageSize,
        offset: pageIndex * pageSize,
        sort: sortParam,
        minLevel: minLevel || undefined,
        maxLevel: maxLevel || undefined,
        status: view || undefined,
      }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => wordsQ.data?.words ?? [], [wordsQ.data]);
  const stats = wordsQ.data?.stats;
  const hasMore = rows.length === pageSize;
  const levelLabel = levelRangeLabel(minLevel, maxLevel);
  // The batch minus words triaged this session — what's actually shown.
  const visibleRows = useMemo(
    () => rows.filter((r) => !triaged.has(r.word)),
    [rows, triaged],
  );
  const batchDone = rows.length > 0 && visibleRows.length === 0;
  const toReview = view === ""; // the default untriaged view

  const markStatus = useMutation({
    mutationFn: (v: { word: string; status: UserWordStatus }) =>
      // From the book page, triage is "book"-sourced: a learning→known here is a correction,
      // not a learned word (it won't feed the Learned series).
      setWordStatus(v.word, v.status, book?.language ?? "en", "book"),
    onSuccess: () => {
      // Refresh the header counts and the cross-book vocabulary list — but deliberately
      // NOT ["words", id]: the loaded batch stays frozen so triaged words simply drop out
      // and nothing new slides in mid-review.
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: ["review"] });
    },
    onError: (err, v) => {
      // The row was hidden optimistically — bring it back so the table reflects reality.
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
  // Mark a word and remove it from the current batch locally (no refetch, no refill).
  const markWord = (word: string, status: UserWordStatus) => {
    setTriaged((prev) => new Set(prev).add(word));
    markStatus.mutate({ word, status });
  };
  const markWordRef = useRef(markWord);
  markWordRef.current = markWord;

  const columns = useMemo<ColumnDef<BookWordRow>[]>(() => {
    const cols: ColumnDef<BookWordRow>[] = [
      {
        accessorKey: "word",
        header: "Word",
        cell: ({ row }) => {
          const w = row.original;
          return (
            <button
              className="word-link"
              title={`${w.count}× · ${w.level ?? "no level"}`}
              onClick={() => setOpenWord(w)}
            >
              {w.word}
            </button>
          );
        },
      },
      {
        accessorKey: "level",
        header: "Level",
        cell: ({ row }) => <LevelBadge level={row.original.level} />,
      },
      {
        accessorKey: "count",
        header: "Count",
        cell: ({ row }) => (
          <span className="num">{row.original.count.toLocaleString()}</span>
        ),
      },
    ];
    if (view !== "") {
      cols.push({
        accessorKey: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      });
    }
    // Per-row triage: one button per status, on the right where the eye lands after
    // reading. The word's current status (if any) is shown active and disabled.
    cols.push({
      id: "triage",
      header: "Triage",
      enableSorting: false,
      cell: ({ row }) => {
        const w = row.original;
        return (
          <span className="row-actions">
            {TRIAGE.map((t) => {
              const active = w.status === t.status;
              return (
                <button
                  key={t.status}
                  className={`btn ${t.cls} slim${active ? " active" : ""}`}
                  disabled={active}
                  onClick={() => markWordRef.current(w.word, t.status)}
                >
                  {t.label}
                </button>
              );
            })}
          </span>
        );
      },
    });
    return cols;
  }, [view]);

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: { sorting },
    manualSorting: true,
    enableMultiSort: true,
    getRowId: (row) => row.word,
    onSortingChange: (updater) => {
      setSorting(updater);
      resetView();
    },
    getCoreRowModel: getCoreRowModel(),
  });

  // Drop the frozen batch and pull a fresh one (used after "Finish book" and to advance
  // to the next batch once the current one is fully triaged).
  const reloadQueue = () => {
    setTriaged(new Set());
    setPageIndex(0);
    qc.invalidateQueries({ queryKey: ["words", id] });
    qc.invalidateQueries({ queryKey: ["book", id] });
    // Land back at the top so the next batch starts from the first row.
    window.scrollTo({ top: 0 });
  };
  const finish = useMutation({
    mutationFn: () => finishBook(id),
    onSuccess: () => {
      reloadQueue();
      setConfirmFinish(false);
    },
  });

  // "Complete batch": mark every word still showing in the current batch as known in one
  // request, then advance to the next batch. Per-row "Learning"/"Ignore" already dropped
  // out of visibleRows, so this only resolves the ones you haven't picked out.
  const completeBatch = useMutation({
    mutationFn: () =>
      reviewBatch(
        id,
        visibleRows.map((r) => r.word),
        [],
        "known",
      ),
    onSuccess: () => {
      reloadQueue();
      setConfirmComplete(false);
    },
  });

  return (
    <section>
      <div className="page-head">
        <Link to="/" className="linkbtn">
          ← Books
        </Link>
        <span className="grow" />
        <Link to={`/books/${id}/settings`} className="btn ghost slim">
          Settings
        </Link>
        {ready && (
          <button className="btn ghost slim" onClick={() => setConfirmFinish(true)}>
            Finish book
          </button>
        )}
      </div>

      {bookQ.isLoading ? (
        <p className="muted">Loading…</p>
      ) : !book ? (
        <p className="error">Book not found.</p>
      ) : (
        <>
          <div className="book-header">
            <h2>{book.title}</h2>
            {book.author && <p className="muted">{book.author}</p>}
            <p className="muted small book-sub">
              {book.status !== "ready" ? (
                <span className="pill amber">{book.status}</span>
              ) : (
                <>
                  <span>{book.chapterCount ?? "—"} chapters</span>
                  {stats && (
                    <>
                      <span>
                        <strong>{stats.remaining.toLocaleString()}</strong> to review
                      </span>
                      <span>{stats.total.toLocaleString()} words in book</span>
                      {book.reviewedAt && <span className="pill green">reviewed</span>}
                    </>
                  )}
                </>
              )}
            </p>
          </div>

          {book.status === "failed" && (
            <p className="error">Processing failed: {book.error}</p>
          )}
          {(book.status === "uploaded" || book.status === "processing") && (
            <p className="muted">Analyzing the book… this updates automatically.</p>
          )}

          {ready && (
            <div className="toolbar">
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
                per batch
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

              <span className="grow" />
              <span className="muted small hint">Shift-click headers to multi-sort</span>
            </div>
          )}

          {ready && (
            <>
              {stats && (
                <p className="stats-line muted small">
                  <strong>{visibleRows.length.toLocaleString()}</strong>
                  {levelLabel ? ` ${levelLabel} ` : " "}
                  {view === "" ? "words" : view === "all" ? "words (all)" : `${view} words`}
                  {" left in this batch"}
                  {/* With a filter active, the across-book count that matches it. Worded as
                      "match your filter" (not "to review") so it doesn't collide with the
                      header's unfiltered "to review" total, which stays fixed while filtering. */}
                  {levelLabel ? (
                    <>
                      {" · "}
                      <strong>{stats.filtered.toLocaleString()}</strong>
                      {" match your filter"}
                    </>
                  ) : (
                    toReview && ` · ${stats.remaining.toLocaleString()} to review in book`
                  )}
                </p>
              )}

              <div className="table-wrap">
                <table className="words">
                  <thead>
                    {table.getHeaderGroups().map((hg) => (
                      <tr key={hg.id}>
                        {hg.headers.map((header) => {
                          const sorted = header.column.getIsSorted();
                          const canSort = header.column.getCanSort();
                          const multi = sorting.length > 1;
                          const align =
                            header.column.id === "count"
                              ? "right"
                              : header.column.id === "triage"
                                ? "right"
                                : "";
                          return (
                            <th
                              key={header.id}
                              className={[
                                `col-${header.column.id}`,
                                align,
                                canSort ? "sortable" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              onClick={
                                canSort ? header.column.getToggleSortingHandler() : undefined
                              }
                            >
                              {flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                              {sorted && (
                                <span className="sort-ind">
                                  {sorted === "asc" ? " ▲" : " ▼"}
                                  {multi && <sup>{header.column.getSortIndex() + 1}</sup>}
                                </span>
                              )}
                            </th>
                          );
                        })}
                      </tr>
                    ))}
                  </thead>
                  <tbody>
                    {table.getRowModel().rows.map((row) => (
                      <tr key={row.id}>
                        {row.getVisibleCells().map((cell) => {
                          const align =
                            cell.column.id === "count"
                              ? "right"
                              : cell.column.id === "triage"
                                ? "right"
                                : "";
                          return (
                            <td
                              key={cell.id}
                              className={[`col-${cell.column.id}`, align]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {visibleRows.length === 0 &&
                  (batchDone ? (
                    <div className="empty batch-done">
                      <p className="muted">Batch triaged — nice work.</p>
                      <button className="btn primary" onClick={reloadQueue}>
                        Load next batch →
                      </button>
                    </div>
                  ) : (
                    <p className="muted empty">
                      {!toReview
                        ? "No words match this view."
                        : levelLabel
                          ? `No untriaged ${levelLabel} words.`
                          : "No words left in the queue — this book is fully triaged."}
                    </p>
                  ))}
              </div>

              {/* Browse other batches; triaging happens per-row, in place. */}
              <div className="review-bar">
                <div className="pager">
                  <button
                    className="btn ghost"
                    disabled={pageIndex === 0}
                    onClick={() => {
                      setPageIndex((p) => Math.max(0, p - 1));
                      setTriaged(new Set());
                    }}
                  >
                    ← Prev
                  </button>
                  <span className="muted small">Batch {pageIndex + 1}</span>
                  <button
                    className="btn ghost"
                    disabled={!hasMore}
                    onClick={() => {
                      setPageIndex((p) => p + 1);
                      setTriaged(new Set());
                    }}
                  >
                    Next →
                  </button>
                </div>
                {toReview && visibleRows.length > 0 && (
                  <div className="review-actions">
                    <button
                      className="btn primary"
                      onClick={() => setConfirmComplete(true)}
                    >
                      Complete batch
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {confirmFinish && (
        <ConfirmDialog
          title="Finish this book?"
          message="Every remaining untriaged word is marked as known. Use this only when you've worked through the words you care about."
          confirmLabel="Finish book"
          danger
          busy={finish.isPending}
          onConfirm={() => finish.mutate()}
          onCancel={() => setConfirmFinish(false)}
        />
      )}

      {confirmComplete && (
        <ConfirmDialog
          title="Complete this batch?"
          message={`All ${visibleRows.length.toLocaleString()} word${
            visibleRows.length === 1 ? "" : "s"
          } still showing in this batch will be marked as known.`}
          confirmLabel="Mark all known"
          busy={completeBatch.isPending}
          onConfirm={() => completeBatch.mutate()}
          onCancel={() => setConfirmComplete(false)}
        />
      )}

      {openWord && book && (
        <WordModal
          bookId={id}
          word={openWord.word}
          language={book.language}
          source="book"
          initial={openWord}
          onClose={() => setOpenWord(null)}
        />
      )}
    </section>
  );
}
