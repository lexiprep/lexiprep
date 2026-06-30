import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getBook, reprocessBook, updateBook } from "../lib/api";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function BookSettingsPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);

  // Shares the ["book", id] cache with BookPage.
  const bookQ = useQuery({ queryKey: ["book", id], queryFn: () => getBook(id) });
  const book = bookQ.data;
  const inFlight = book?.status === "processing" || book?.status === "uploaded";

  // Details edit mode. Fields are seeded when the user clicks "Edit details".
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [translator, setTranslator] = useState("");

  function startEditing() {
    if (!book) return;
    setTitle(book.title);
    setAuthor(book.author ?? "");
    setTranslator(book.translator ?? "");
    details.reset();
    setEditing(true);
  }

  const details = useMutation({
    mutationFn: () =>
      updateBook(id, { title: title.trim(), author, translator }),
    onSuccess: (updated) => {
      qc.setQueryData(["book", id], updated);
      qc.invalidateQueries({ queryKey: ["books"] });
      setEditing(false);
    },
  });

  const reprocess = useMutation({
    mutationFn: () => reprocessBook(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["book", id] });
      qc.invalidateQueries({ queryKey: ["books"] });
      // The book page polls processing status and shows "Analyzing…".
      navigate(`/books/${id}`);
    },
  });

  return (
    <section>
      <div className="page-head">
        <Link to={`/books/${id}`} className="linkbtn">
          ← Back to book
        </Link>
        <span className="grow" />
      </div>

      {bookQ.isLoading ? (
        <p className="muted">Loading…</p>
      ) : !book ? (
        <p className="error">Book not found.</p>
      ) : (
        <>
          <div className="book-header">
            <h2>{book.title}</h2>
            <p className="muted small">Settings</p>
          </div>

          <div className="card settings-card">
            <h3>Details</h3>
            {editing ? (
              <form
                className="details-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  details.mutate();
                }}
              >
                <label className="field">
                  <span>Title</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label className="field">
                  <span>Author</span>
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} />
                </label>
                <label className="field">
                  <span>Translator</span>
                  <input
                    value={translator}
                    onChange={(e) => setTranslator(e.target.value)}
                  />
                </label>
                {details.isError && (
                  <p className="error small">
                    {details.error instanceof Error
                      ? details.error.message
                      : "Could not save"}
                  </p>
                )}
                <div className="details-actions">
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={details.isPending || !title.trim()}
                  >
                    {details.isPending ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={details.isPending}
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <dl className="details-view">
                  <dt>Title</dt>
                  <dd>{book.title}</dd>
                  <dt>Author</dt>
                  <dd className={book.author ? "" : "muted"}>{book.author || "—"}</dd>
                  <dt>Translator</dt>
                  <dd className={book.translator ? "" : "muted"}>
                    {book.translator || "—"}
                  </dd>
                </dl>
                <button className="btn ghost" onClick={startEditing}>
                  Edit details
                </button>
              </>
            )}
          </div>

          <div className="card settings-card">
            <h3>Reprocess</h3>
            <p className="muted">
              Re-extract this book’s word list with the latest engine — useful after an
              engine update. Your reviewed words (known / learning / ignored) and notes are
              kept; only the extracted word list is rebuilt.
            </p>
            <button
              className="btn primary"
              disabled={reprocess.isPending || inFlight}
              onClick={() => setConfirm(true)}
            >
              {inFlight ? "Processing…" : "Reprocess book"}
            </button>
            {reprocess.isError && (
              <p className="error small">
                {reprocess.error instanceof Error
                  ? reprocess.error.message
                  : "Reprocess failed"}
              </p>
            )}
          </div>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title="Reprocess this book?"
          message="The word list is rebuilt with the latest engine. Your reviewed words and notes are preserved."
          confirmLabel="Reprocess"
          busy={reprocess.isPending}
          onConfirm={() => reprocess.mutate()}
          onCancel={() => setConfirm(false)}
        />
      )}
    </section>
  );
}
