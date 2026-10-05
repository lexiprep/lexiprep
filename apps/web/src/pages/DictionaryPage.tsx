import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getBook,
  recordWordLookup,
  searchBookDictionary,
  type BookWordRow,
} from "../lib/api";
import { LevelBadge } from "../components/badges";
import { WordModal } from "../components/WordModal";
import { useWakeLock } from "../lib/useWakeLock";

// Marks <html> while the dictionary is on screen: the stylesheet turns the dark theme
// true black there, and the browser's own bars follow.
function useDictionaryMode() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dict-mode");
    const metas =
      root.getAttribute("data-theme") === "dark"
        ? [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
        : [];
    const before = metas.map((m) => m.content);
    metas.forEach((m) => (m.content = "#000000"));
    return () => {
      root.classList.remove("dict-mode");
      metas.forEach((m, i) => (m.content = before[i] ?? ""));
    };
  }, []);
}

/**
 * The book's dictionary, for use while reading: one search box over every word of the
 * book (known and ignored included), matches as a plain frequency-ordered list, and the
 * book page's word modal for the meaning. Deliberately bare — it renders outside the app
 * layout, with no nav, filters or triage. Opening a word here counts as a lookup.
 *
 * Built for a phone lying next to the book: the screen stays awake, and the open word is
 * its own history entry, so the back gesture closes it instead of leaving the page.
 */
export function DictionaryPage() {
  const { id = "" } = useParams();
  const inputRef = useRef<HTMLInputElement>(null);
  // Raw input + its debounced, trimmed value (what is actually searched).
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  // Enter pressed before the matches for what is typed have arrived — honoured when they do.
  const [enterQueued, setEnterQueued] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const openWord = (location.state as { word?: BookWordRow } | null)?.word ?? null;

  useWakeLock();
  useDictionaryMode();

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
    setEnterQueued(false);
    // Drop the on-screen keyboard so the meaning gets the whole screen.
    inputRef.current?.blur();
    navigate(".", { state: { word: row } });
  };

  useEffect(() => {
    if (enterQueued && settled && resultsQ.isSuccess) {
      if (rows[0]) open(rows[0]);
      else setEnterQueued(false);
    }
  });

  // Focused here, inside the tap, because a phone only raises the keyboard for a focus
  // that comes from a gesture. The word itself closes when its history entry is left.
  const close = () => {
    inputRef.current?.focus();
    navigate(-1);
  };

  // Back to an empty box, ready for the next word — however the word was closed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !openWord) {
      setInput("");
      setTerm("");
      inputRef.current?.focus();
    }
    wasOpen.current = Boolean(openWord);
  }, [openWord]);

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
            onChange={(e) => {
              setInput(e.target.value);
              setEnterQueued(false);
            }}
            onKeyDown={(e) => {
              // Enter opens the top match — the exact one when there is one.
              if (e.key !== "Enter" || !input.trim()) return;
              if (settled && rows[0]) open(rows[0]);
              else setEnterQueued(true);
            }}
            enterKeyHint="search"
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
