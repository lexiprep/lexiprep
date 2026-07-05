import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  addWordNote,
  deleteWordNote,
  updateWordNote,
  type WordNoteItem,
  type WordSense,
} from "../lib/api";

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
 * Renders a word's meaning with a per-book precedence (spec 03/10):
 *
 *   your definitions  >  AI definition  >  dictionary
 *
 * When a specific book is in context (`bookScoped`), the user's own definitions —
 * several are allowed — replace everything; otherwise the book's AI senses replace the
 * dictionary; otherwise the dictionary senses show. Outside a book context only the
 * dictionary shows, with the user's definitions listed below as an addition. Each user
 * definition edits in place (pencil/trash icons); "+ Add" opens a fresh editor.
 *
 * Layout-neutral — the caller (review card / word modal) supplies the surrounding container.
 */
export function WordMeaning({
  bookId,
  word,
  definition,
  notes,
  aiSenses,
  bookScoped,
  loading,
  maxSenses,
  onNotesChanged,
}: {
  /** The book the user definitions belong to; null disables editing (dictionary only). */
  bookId: string | null;
  /** The lemma the definitions key on. */
  word: string;
  definition: WordSense[] | null;
  /** The user's own definitions for this word in this book. */
  notes: WordNoteItem[];
  /** AI contextual senses for this book (when generated), or null. */
  aiSenses?: WordSense[] | null;
  /** A specific book is selected → user/AI definitions override the dictionary. */
  bookScoped?: boolean;
  loading?: boolean;
  /** Cap the dictionary senses shown (review uses 5; the modal shows all). */
  maxSenses?: number;
  /** Called with the new list after any successful add/edit/remove, so the host can
   * refresh its own copy (modal refetches; the review card updates its queue). */
  onNotesChanged?: (notes: WordNoteItem[]) => void;
}) {
  const [localNotes, setLocalNotes] = useState<WordNoteItem[]>(notes);
  /** Which editor is open: a note id, "new" for the add form, or null. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    setLocalNotes(notes);
  }, [notes]);

  const canNote = !!bookId;

  const applyChange = (next: WordNoteItem[]) => {
    setLocalNotes(next);
    setEditingId(null);
    setText("");
    onNotesChanged?.(next);
  };

  const save = useMutation({
    mutationFn: async () => {
      const value = text.trim();
      if (editingId === "new") {
        const created = await addWordNote(bookId!, word, value);
        return [...localNotes, created];
      }
      await updateWordNote(bookId!, word, editingId!, value);
      return localNotes.map((n) => (n.id === editingId ? { ...n, note: value } : n));
    },
    onSuccess: applyChange,
    onError: (err) => toast.error(errMessage(err, "Couldn't save your definition.")),
  });
  const remove = useMutation({
    mutationFn: async (noteId: string) => {
      await deleteWordNote(bookId!, word, noteId);
      return localNotes.filter((n) => n.id !== noteId);
    },
    onSuccess: applyChange,
    onError: (err) => toast.error(errMessage(err, "Couldn't remove your definition.")),
  });

  const startEdit = (n: WordNoteItem) => {
    setEditingId(n.id);
    setText(n.note);
  };
  const startAdd = () => {
    setEditingId("new");
    setText("");
  };

  const editForm = (
    <div className="wm-edit">
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
          disabled={!text.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {editingId === "new" ? "Save" : "Update"}
        </button>
        <button
          className="btn ghost slim"
          onClick={() => {
            setEditingId(null);
            setText("");
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  /** The user's definitions as a block: list + per-row actions + the add editor. */
  const notesBlock = (label: string) => (
    <div className="wm-block">
      <div className="wm-head">
        <span>{label}</span>
      </div>
      {localNotes.map((n) =>
        editingId === n.id ? (
          <div key={n.id}>{editForm}</div>
        ) : (
          <div key={n.id} className="wm-note-row">
            <p className="wm-note-text">{n.note}</p>
            <span className="wm-actions">
              <button
                className="icon-btn"
                title="Edit"
                aria-label="Edit definition"
                onClick={() => startEdit(n)}
              >
                <PencilIcon />
              </button>
              <button
                className="icon-btn"
                title="Remove"
                aria-label="Remove definition"
                disabled={remove.isPending}
                onClick={() => remove.mutate(n.id)}
              >
                <TrashIcon />
              </button>
            </span>
          </div>
        ),
      )}
      {editingId === "new" ? (
        editForm
      ) : (
        <button className="wm-add" onClick={startAdd}>
          {localNotes.length > 0 ? "+ Add another definition" : "+ Add your own definition"}
        </button>
      )}
    </div>
  );

  const sensesList = (senses: WordSense[]) => (
    <ol className="senses">
      {senses.map((s, i) => (
        <li key={i}>
          <span className="pos">{s.pos}</span>
          <span>{s.gloss}</span>
          {s.example && <span className="muted small sense-ex">“{s.example}”</span>}
        </li>
      ))}
    </ol>
  );

  // Book-scoped + own definitions → they ARE the definition (AI + dictionary hidden).
  if (bookScoped && (localNotes.length > 0 || editingId === "new")) {
    return (
      <div className="word-meaning">
        {notesBlock(localNotes.length > 1 ? "Your definitions" : "Your definition")}
      </div>
    );
  }

  // Book-scoped + an AI definition → it replaces the dictionary for this book.
  if (bookScoped && aiSenses && aiSenses.length > 0) {
    return (
      <div className="word-meaning">
        <div className="wm-block">
          <div className="wm-head">
            <span>
              AI definition <span className="ai-badge">AI</span>
            </span>
          </div>
          {sensesList(aiSenses)}
          <p className="muted small">AI-generated from this book’s context — may be imprecise.</p>
        </div>
        {canNote && (
          <button className="wm-add" onClick={startAdd}>
            + Add your own definition
          </button>
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
        ) : definition && definition.length > 0 ? (
          sensesList(maxSenses != null ? definition.slice(0, maxSenses) : definition)
        ) : (
          <p className="muted small">No definition found for this word.</p>
        )}
      </div>

      {canNote &&
        (localNotes.length > 0 || editingId === "new" ? (
          notesBlock(localNotes.length > 1 ? "Your notes" : "Your note")
        ) : (
          <button className="wm-add" onClick={startAdd}>
            {bookScoped ? "+ Add your own definition" : "+ Add your own note"}
          </button>
        ))}
    </div>
  );
}
