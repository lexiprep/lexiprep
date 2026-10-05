import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getBook,
  recordWordLookup,
  searchBookDictionary,
  type BookWordRow,
} from "../lib/api";
import { LevelBadge } from "../components/badges";
import { WordModal } from "../components/WordModal";

/**
 * The book's dictionary, for use while reading: one search box over every word of the
 * book (known and ignored included), matches as a plain frequency-ordered list, and the
 * book page's word modal for the meaning. Deliberately bare — it renders outside the app
 * layout, with no nav, filters or triage. Opening a word here counts as a lookup.
 */
export function DictionaryPage() {
  const { id = "" } = useParams();
  const inputRef = useRef<HTMLInputElement>(null);
  // Raw input + its debounced, trimmed value (what is actually searched).
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [openWord, setOpenWord] = useState<BookWordRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(input.trim()), 200);
    return () => clearTimeout(t);
  }, [input]);

  const bookQ = useQuery({ queryKey: ["book", id], queryFn: () => getBook(id) });
  const book = bookQ.data;

  const resultsQ = useQuery({
    queryKey: ["dictionary", id, term],
    queryFn: () => searchBookDictionary(id, term),
    enabled: Boolean(book) && term !== "",
    placeholderData: keepPreviousData,
  });
  const rows = term ? (resultsQ.data ?? []) : [];
  // The list on screen answers what is typed (not a stale, still-debouncing query).
  const settled = term === input.trim() && !resultsQ.isPlaceholderData;

  const open = (row: BookWordRow) => {
    // Fire-and-forget: a failed count must never get between the reader and the meaning.
    recordWordLookup(id, row.word).catch(() => {});
    setOpenWord(row);
  };

  // Back to an empty box, ready for the next word.
  const close = () => {
    setOpenWord(null);
    setInput("");
    setTerm("");
    inputRef.current?.focus();
  };

  return (
    <main className="dict-page">
      <div className="dict-head">
        <Link to={`/books/${id}`} className="linkbtn">
          ← Book
        </Link>
        {book && <span className="dict-title muted small">{book.title}</span>}
      </div>

      {bookQ.isLoading ? (
        <p className="muted">Loading…</p>
      ) : !book ? (
        <p className="error">Book not found.</p>
      ) : (
        <>
          <input
            ref={inputRef}
            type="search"
            className="search-input dict-input"
            placeholder="Look up a word…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the top match — the exact one when there is one.
              if (e.key === "Enter" && settled && rows[0]) open(rows[0]);
            }}
            aria-label="Look up a word"
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />

          {rows.length > 0 && (
            <ul className="dict-results">
              {rows.map((r) => (
                <li key={r.word}>
                  <button className="dict-row" onClick={() => open(r)}>
                    <span className="dict-word">{r.word}</span>
                    <LevelBadge level={r.level} />
                    <span className="count-chip">{r.count.toLocaleString()}×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {term && settled && resultsQ.isSuccess && rows.length === 0 && (
            <p className="muted">No word in this book matches “{term}”.</p>
          )}
        </>
      )}

      {openWord && book && (
        <WordModal
          bookId={id}
          word={openWord.word}
          language={book.language}
          source="book"
          bookScoped
          initial={openWord}
          onClose={close}
        />
      )}
    </main>
  );
}
