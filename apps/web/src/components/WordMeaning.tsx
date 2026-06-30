import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { deleteWordNote, setWordNote, type WordSense } from "../lib/api";

const errMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V5h6v2m-7 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Renders a word's meaning: the dictionary definition and/or the user's own per-book note.
 *
 * When a specific book is in context (`bookScoped`) AND the user has written a note for it,
 * that note *replaces* the dictionary definition ("show only my definition"). Otherwise the
 * dictionary senses show, with the note as an addition below. Either way the note edits in
 * place: it displays as text with edit/remove icons on the right, and only becomes a textarea
 * when you click edit (or "+ Add your own note").
 *
 * Layout-neutral — the caller (review card / word modal) supplies the surrounding container.
 */
export function WordMeaning({
  bookId,
  word,
  definition,
  note,
  bookScoped,
  loading,
  maxSenses,
  onNoteSaved,
}: {
  /** The book the note belongs to; null disables the note editor (dictionary only). */
  bookId: string | null;
  /** The lemma the note keys on. */
  word: string;
  definition: WordSense[] | null;
  note: string | null;
  /** A specific book is selected → a note overrides the dictionary definition. */
  bookScoped?: boolean;
  loading?: boolean;
  /** Cap the dictionary senses shown (review uses 5; the modal shows all). */
  maxSenses?: number;
  /** Called after a successful save/remove with the new note value (null on remove), so the
   * host can refresh its own copy (modal refetches; the review card updates its queue). */
  onNoteSaved?: (note: string | null) => void;
}) {
  const current = note ?? "";
  const [localNote, setLocalNote] = useState(current);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current);
  useEffect(() => {
    setLocalNote(current);
    setText(current);
  }, [current]);

  const canNote = !!bookId;

  const save = useMutation({
    mutationFn: () => setWordNote(bookId!, word, text.trim()),
    onSuccess: () => {
      const v = text.trim();
      setLocalNote(v);
      setEditing(false);
      onNoteSaved?.(v);
    },
    onError: (err) => toast.error(errMessage(err, "Couldn't save your note.")),
  });
  const remove = useMutation({
    mutationFn: () => deleteWordNote(bookId!, word),
    onSuccess: () => {
      setLocalNote("");
      setText("");
      setEditing(false);
      onNoteSaved?.(null);
    },
    onError: (err) => toast.error(errMessage(err, "Couldn't remove your note.")),
  });

  const senses = maxSenses != null ? definition?.slice(0, maxSenses) : definition;
  const override = !!bookScoped && !!localNote;

  const noteActions = (
    <span className="wm-actions">
      <button className="icon-btn" title="Edit" aria-label="Edit note" onClick={() => setEditing(true)}>
        <PencilIcon />
      </button>
      <button
        className="icon-btn"
        title="Remove"
        aria-label="Remove note"
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        <TrashIcon />
      </button>
    </span>
  );

  const editForm = (label: string) => (
    <div className="wm-block">
      <div className="wm-head">
        <span>{label}</span>
      </div>
      <textarea
        className="note-input"
        rows={2}
        autoFocus
        placeholder="Add a meaning specific to this book's context…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="note-actions">
        <button
          className="btn primary slim"
          disabled={!text.trim() || text.trim() === localNote || save.isPending}
          onClick={() => save.mutate()}
        >
          {localNote ? "Update" : "Save"}
        </button>
        <button
          className="btn ghost slim"
          onClick={() => {
            setEditing(false);
            setText(localNote);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  // Book-scoped + a note → the note IS the definition.
  if (override) {
    return (
      <div className="word-meaning">
        {editing ? (
          editForm("Your definition")
        ) : (
          <div className="wm-block">
            <div className="wm-head">
              <span>Your definition</span>
              {noteActions}
            </div>
            <p className="wm-note-text">{localNote}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="word-meaning">
      <div className="wm-block">
        <div className="wm-head">
          <span>Definition</span>
        </div>
        {loading ? (
          <p className="muted small">Loading…</p>
        ) : senses && senses.length > 0 ? (
          <ol className="senses">
            {senses.map((s, i) => (
              <li key={i}>
                <span className="pos">{s.pos}</span>
                <span>{s.gloss}</span>
                {s.example && <span className="muted small sense-ex">“{s.example}”</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">No definition found for this word.</p>
        )}
      </div>

      {canNote &&
        (editing ? (
          editForm("Your note")
        ) : localNote ? (
          <div className="wm-block">
            <div className="wm-head">
              <span>Your note</span>
              {noteActions}
            </div>
            <p className="wm-note-text">{localNote}</p>
          </div>
        ) : (
          <button className="wm-add" onClick={() => setEditing(true)}>
            + Add your own note
          </button>
        ))}
    </div>
  );
}
