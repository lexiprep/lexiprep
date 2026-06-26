import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearWordStatus,
  deleteWordNote,
  getWordDetail,
  setWordNote,
  setWordStatus,
  type UserWordStatus,
} from "../lib/api";
import { LevelBadge, StatusBadge } from "./badges";

const ACTIONS: { status: UserWordStatus; label: string; cls: string }[] = [
  { status: "learning", label: "Learning", cls: "blue" },
  { status: "known", label: "Known", cls: "green" },
  { status: "ignored", label: "Ignore", cls: "gray" },
];

export function WordModal({
  bookId,
  word,
  language,
  onClose,
}: {
  bookId: string;
  word: string;
  language: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["word", bookId, word],
    queryFn: () => getWordDetail(bookId, word),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["words", bookId] });
    qc.invalidateQueries({ queryKey: ["word", bookId, word] });
    // Keep the cross-book learning list in sync when status changes from the modal.
    qc.invalidateQueries({ queryKey: ["review"] });
  };

  const mark = useMutation({
    mutationFn: (status: UserWordStatus) => setWordStatus(word, status, language),
    onSuccess: invalidate,
  });
  const clear = useMutation({
    mutationFn: () => clearWordStatus(word, language),
    onSuccess: invalidate,
  });

  const [noteText, setNoteText] = useState("");
  useEffect(() => {
    setNoteText(detail.data?.note ?? "");
  }, [detail.data?.note]);

  const saveNote = useMutation({
    mutationFn: () => setWordNote(bookId, word, noteText.trim()),
    onSuccess: invalidate,
  });
  const removeNote = useMutation({
    mutationFn: () => deleteWordNote(bookId, word),
    onSuccess: () => {
      setNoteText("");
      invalidate();
    },
  });

  const d = detail.data;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {detail.isLoading || !d ? (
          <p className="muted modal-body">Loading…</p>
        ) : (
          <>
            <div className="modal-body">
              <div className="modal-head">
                <h2>{d.word}</h2>
                <LevelBadge level={d.level} />
                <span className="count-chip">{d.count.toLocaleString()}×</span>
                <StatusBadge status={d.status} />
              </div>

              {d.example && <p className="example">“{d.example}”</p>}

              <div className="modal-section">
                <h4>Definition</h4>
                {d.definition && d.definition.length > 0 ? (
                  <ol className="senses">
                    {d.definition.map((s, i) => (
                      <li key={i}>
                        <span className="pos">{s.pos}</span>
                        <span>{s.gloss}</span>
                        {s.example && (
                          <span className="muted small sense-ex">“{s.example}”</span>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted small">No definition found for this word.</p>
                )}
              </div>

              <div className="modal-section">
                <h4>Your note {d.note && <span className="dot-saved" title="saved" />}</h4>
                <textarea
                  className="note-input"
                  rows={2}
                  placeholder="Add a meaning specific to this book’s context…"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
                <div className="note-actions">
                  <button
                    className="btn primary slim"
                    disabled={
                      !noteText.trim() ||
                      noteText.trim() === (d.note ?? "") ||
                      saveNote.isPending
                    }
                    onClick={() => saveNote.mutate()}
                  >
                    {d.note ? "Update note" : "Save note"}
                  </button>
                  {d.note && (
                    <button
                      className="btn ghost slim"
                      disabled={removeNote.isPending}
                      onClick={() => removeNote.mutate()}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {d.forms.length > 1 && (
                <div className="modal-section">
                  <h4>Forms in this book</h4>
                  <p className="forms-inline">
                    {d.forms.map((f) => (
                      <span key={f.word} className="form-chip">
                        {f.word}
                        <span className="count-chip">{f.count}×</span>
                      </span>
                    ))}
                  </p>
                </div>
              )}

              <p className="muted modal-attribution">
                Definitions: Open English WordNet (CC BY) · Wiktionary (CC BY-SA)
              </p>
            </div>

            {/* Pinned footer: status actions stay visible while the body scrolls. */}
            <div className="modal-foot">
              <div className="modal-actions">
                {ACTIONS.map((a) => {
                  const active = d.status === a.status;
                  return (
                    <button
                      key={a.status}
                      className={`btn ${a.cls}${active ? " active" : ""}`}
                      disabled={mark.isPending || clear.isPending}
                      title={active ? `Click to remove “${a.label}”` : undefined}
                      onClick={() => (active ? clear.mutate() : mark.mutate(a.status))}
                    >
                      {active ? `✓ ${a.label}` : a.label}
                    </button>
                  );
                })}
              </div>
              {d.status && (
                <p className="muted small center action-hint">
                  Click the highlighted button again to undo.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
