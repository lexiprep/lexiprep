import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listBooks, uploadBook, type Book, type BookStatus } from "../lib/api";

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

  const upload = useMutation({
    mutationFn: uploadBook,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["books"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Upload failed"),
  });

  function onPick(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".epub")) {
      setError("Only .epub files are supported");
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
          accept=".epub,application/epub+zip"
          hidden
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <button
          className="btn primary"
          onClick={() => fileInput.current?.click()}
          disabled={upload.isPending}
        >
          {upload.isPending ? "Uploading…" : "Upload EPUB"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {books.isLoading ? (
        <p className="muted">Loading…</p>
      ) : books.data && books.data.length > 0 ? (
        <div className="book-grid">
          {books.data.map((b) => (
            <BookCard key={b.id} book={b} />
          ))}
        </div>
      ) : (
        <p className="muted empty">No books yet. Upload an EPUB to get started.</p>
      )}
    </section>
  );
}

function BookCard({ book }: { book: Book }) {
  const ready = book.status === "ready";
  const inner = (
    <>
      <div className="book-card-top">
        <h3>{book.title}</h3>
        <StatusPill status={book.status} />
      </div>
      {book.author && <p className="muted small">{book.author}</p>}
      {book.status === "failed" && book.error && (
        <p className="error small">{book.error}</p>
      )}
      <div className="book-meta muted small">
        {ready && (
          <>
            <span>{book.chapterCount ?? "—"} chapters</span>
            <span>{(book.tokenCount ?? 0).toLocaleString()} tokens</span>
            {book.reviewedAt && <span className="pill green">reviewed</span>}
          </>
        )}
        {!ready && book.status !== "failed" && <span>Analyzing…</span>}
      </div>
    </>
  );

  return ready ? (
    <Link to={`/books/${book.id}`} className="card book-card linkcard">
      {inner}
    </Link>
  ) : (
    <div className="card book-card">{inner}</div>
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
