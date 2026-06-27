import { useState } from "react";
import { exportDeckUrl, type Book } from "../lib/api";
import { LevelRange } from "./LevelRange";
import { ModalOverlay } from "./ModalOverlay";

/**
 * Export options for the Anki deck (Learning tab). Optionally filter by one or more books
 * and by a CEFR range, then download a TSV (word + context on the front, definition on the
 * back). No selection = all books / all levels.
 */
export function ExportModal({ books, onClose }: { books: Book[]; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function doExport() {
    const url = exportDeckUrl({
      books: [...selected],
      minLevel: minLevel || undefined,
      maxLevel: maxLevel || undefined,
    });
    // Trigger the browser download (same-origin GET carries the session cookie).
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  }

  return (
    <ModalOverlay onClose={onClose} className="confirm export-modal">
      <h3>Export to Anki</h3>
      <p className="muted small">
        Your <strong>Learning</strong> words as an Anki deck — the word in context on the
        front, the definition (hidden) on the back.
      </p>

      <div className="export-section">
        <div className="export-label">
          Books{" "}
          <span className="muted small">
            {selected.size === 0 ? "(all books)" : `(${selected.size} selected)`}
          </span>
        </div>
        {books.length === 0 ? (
          <p className="muted small">No books yet.</p>
        ) : (
          <div className="export-books">
            {books.map((b) => (
              <label key={b.id} className="export-book">
                <input
                  type="checkbox"
                  checked={selected.has(b.id)}
                  onChange={() => toggle(b.id)}
                />
                <span>{b.title}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="export-section">
        <LevelRange
          from={minLevel}
          to={maxLevel}
          onChange={({ from, to }) => {
            setMinLevel(from);
            setMaxLevel(to);
          }}
        />
      </div>

      <div className="confirm-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={doExport}>
          Export deck
        </button>
      </div>
    </ModalOverlay>
  );
}
