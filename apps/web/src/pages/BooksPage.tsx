import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listBooks, uploadBook, type Book, type BookStatus } from "../lib/api";
import { UsageDemo } from "../components/UsageDemo";

const STATUS_LABEL: Record<BookStatus, string> = {
  uploaded: "queued",
  processing: "processing",
  ready: "ready",
  failed: "failed",
};

export function BooksPage() {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const books = useQuery({
    queryKey: ["books"],
    queryFn: listBooks,
    // Poll while anything is still being processed.
    refetchInterval: (q) =>
      q.state.data?.some((b) => b.status === "uploaded" || b.status === "processing")
        ? 1500
        : false,
  });

  // Books seen mid-processing this session. A book that finishes while you watch shows
  // "ready" once (it's in this set); a book already ready on load never enters it, so its
  // status pill stays hidden — once processed, a book is obviously ready.
  const seenPending = useRef<Set<string>>(new Set());
  for (const b of books.data ?? []) {
    if (b.status === "uploaded" || b.status === "processing") seenPending.current.add(b.id);
  }

  const upload = useMutation({
    mutationFn: uploadBook,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["books"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Upload failed"),
  });

  function onPick(file: File | undefined) {
    setError(null);
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith(".epub") && !name.endsWith(".pdf")) {
      setError("Only .epub and .pdf files are supported");
      return;
    }
    upload.mutate(file);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <section>
      <div className="page-head">
        <h2>Your books</h2>
        <div className="grow" />
        <input
          ref={fileInput}
          type="file"
          accept=".epub,.pdf,application/epub+zip,application/pdf"
          hidden
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <button
          className="btn primary"
          onClick={() => fileInput.current?.click()}
          disabled={upload.isPending}
        >
          {upload.isPending ? "Uploading…" : "Upload book"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {books.isLoading ? (
        <p className="muted">Loading…</p>
      ) : books.data && books.data.length > 0 ? (
        <div className="book-grid">
          {books.data.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              showStatus={b.status !== "ready" || seenPending.current.has(b.id)}
            />
          ))}
        </div>
      ) : (
        <p className="muted empty">No books yet. Upload an EPUB or PDF to get started.</p>
      )}

      {import.meta.env.DEV && <UsageDemo />}
    </section>
  );
}

function BookCard({ book, showStatus }: { book: Book; showStatus: boolean }) {
  const ready = book.status === "ready";
  return (
    <div className={`card book-card${ready ? " linkcard" : ""}`}>
      {/* Whole-card link to open the book (stretched over the card via ::after).
          The gear link sits above it (z-index) so Settings stays separately clickable. */}
      {ready && (
        <Link
          to={`/books/${book.id}`}
          className="stretched-link"
          aria-label={`Open ${book.title}`}
        />
      )}
      <div className="book-card-top">
        <h3>{book.title}</h3>
        <div className="book-card-actions">
          {showStatus && <StatusPill status={book.status} />}
          <Link
            to={`/books/${book.id}/settings`}
            className="card-gear"
            title="Settings"
            aria-label={`Settings for ${book.title}`}
          >
            <GearIcon />
          </Link>
        </div>
      </div>
      {book.author && <p className="muted small">{book.author}</p>}
      {book.status === "failed" && book.error && (
        <p className="error small">{book.error}</p>
      )}
      <div className="book-meta muted small">
        {ready && (
          <>
            <span>{(book.uniqueWords ?? 0).toLocaleString()} unique words</span>
            <span>{(book.wordsToReview ?? 0).toLocaleString()} to review</span>
            {book.reviewedAt && <span className="pill green">reviewed</span>}
          </>
        )}
        {!ready && book.status !== "failed" && <span>Analyzing…</span>}
      </div>
    </div>
  );
}

/** Solid cog icon (Material "settings"), colored via currentColor. */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  );
}

function StatusPill({ status }: { status: BookStatus }) {
  const cls =
    status === "ready"
      ? "green"
      : status === "failed"
        ? "red"
        : "amber";
  return <span className={`pill ${cls}`}>{STATUS_LABEL[status]}</span>;
}
