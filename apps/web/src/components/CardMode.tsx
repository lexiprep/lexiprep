import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearWordStatus,
  setWordStatus,
  type BookWordRow,
  type UserWordStatus,
} from "../lib/api";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";
import { usePersistentState } from "../lib/usePersistentState";
import {
  AXIS_LOCK,
  MAX_TILT,
  swipeDecision,
  swipeProgress,
  swipeTilt,
  swipeVelocity,
} from "../lib/swipe";
import { CardModeCard } from "./CardModeCard";

/**
 * Card mode — the book page's vocabulary batch as a swipeable deck.
 *
 * Deliberately NOT built on <ModalOverlay>, despite the house rule that modals use it:
 * that wrapper is a centred panel whose backdrop closes on click, and on a full-screen
 * swipe surface a stray tap outside the card would eject you mid-deck. So this owns its
 * own `position: fixed; inset: 0` shell and calls `useBodyScrollLock()` directly — the
 * very hook ModalOverlay uses — so the "background never scrolls" rule still holds.
 *
 * Triage itself is not reimplemented here: `onDecide` is the book page's `markWord`, so a
 * swipe and a table button are the same code path, including the frozen-batch rule and the
 * error rollback. Only undo is local, since only this surface has one.
 */

/** Session options chosen on the intro screen. An object from day one — more settings are coming. */
export interface CardModeSettings {
  /** How many cards this session (see `countOptions`). */
  count: number;
}
const DEFAULT_SETTINGS: CardModeSettings = { count: 20 };

const ACTIONS: { status: UserWordStatus; label: string; cls: string; hint: string }[] = [
  { status: "learning", label: "Learning", cls: "blue", hint: "←" },
  { status: "ignored", label: "Ignore", cls: "gray", hint: "↓" },
  { status: "known", label: "Known", cls: "green", hint: "→" },
];

/** Which way a decision throws the card. Ignore drops it rather than picking a side. */
const FLY: Record<UserWordStatus, "left" | "right" | "down"> = {
  learning: "left",
  known: "right",
  ignored: "down",
};

const FLY_MS = 240;

/**
 * Session-size choices: multiples of 5 up to 50, plus the whole deck when it doesn't
 * land on one (so a 12-word batch offers 5 · 10 · All (12), and a 3-word batch just All (3)).
 */
export function countOptions(deckSize: number): number[] {
  const opts: number[] = [];
  for (let n = 5; n <= Math.min(50, deckSize); n += 5) opts.push(n);
  if (deckSize > 0 && deckSize < 50 && opts[opts.length - 1] !== deckSize) {
    opts.push(deckSize);
  }
  return opts;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const errMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function CardMode({
  bookId,
  language,
  rows,
  onDecide,
  onRestore,
  onClose,
}: {
  bookId: string;
  language: string;
  /** The book page's currently visible batch — snapshotted into a deck when you hit Start. */
  rows: BookWordRow[];
  /** The book page's `markWord`: marks the word and drops it from the frozen batch. */
  onDecide: (word: string, status: UserWordStatus) => void;
  /** Put a word back into the batch after its status was reverted by undo. */
  onRestore: (word: string) => void;
  onClose: () => void;
}) {
  useBodyScrollLock();
  const qc = useQueryClient();

  const [settings, setSettings] = usePersistentState<CardModeSettings>(
    bookId ? `lexiprep.book.${bookId}.cards` : null,
    DEFAULT_SETTINGS,
  );
  const [phase, setPhase] = useState<"intro" | "cards" | "summary">("intro");
  const [deck, setDeck] = useState<BookWordRow[]>([]);
  /** Every decision this session, in order. The card index IS `decisions.length`, and undo
   *  is a pop — which is also why undo is inherently single-step: only the tail is live. */
  const [decisions, setDecisions] = useState<
    { card: BookWordRow; status: UserWordStatus }[]
  >([]);
  const [revealed, setRevealed] = useState(false);
  /** Undo is single-step: spent once used, and re-armed by the next decision. `decisions`
   *  could walk back the whole session, but one step back is the promise the button makes. */
  const [undoSpent, setUndoSpent] = useState(false);
  /** Set while a card animates off-screen; input is ignored until it lands. */
  const [flying, setFlying] = useState<"left" | "right" | "down" | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const flyTimer = useRef<number | undefined>(undefined);
  /** Live drag bookkeeping — a ref, not state, so pointermove doesn't re-render to store it. */
  const origin = useRef<
    { id: number; x: number; y: number; t: number; axis: "x" | "y" | null } | null
  >(null);

  useEffect(() => () => window.clearTimeout(flyTimer.current), []);
  // Take focus so the keyboard shortcuts work without a click first.
  useEffect(() => {
    rootRef.current?.focus();
  }, [phase]);

  const index = decisions.length;
  const card = phase === "cards" ? deck[index] : undefined;

  // Last card decided → the deck is done. (Undo walks the index back and returns to "cards".)
  useEffect(() => {
    if (phase === "cards" && index >= deck.length) setPhase("summary");
  }, [phase, index, deck.length]);
  const options = countOptions(rows.length);
  // Clamp a remembered count to this batch: a saved 50 on a 12-word batch selects All (12).
  const selectedCount =
    options.filter((n) => n <= settings.count).pop() ?? options[0] ?? 0;

  const tally = useMemo(() => {
    const t: Record<UserWordStatus, number> = { learning: 0, known: 0, ignored: 0 };
    for (const d of decisions) t[d.status] += 1;
    return t;
  }, [decisions]);

  const start = (cards: BookWordRow[]) => {
    setDeck(cards);
    setDecisions([]);
    setRevealed(false);
    setDrag(null);
    setFlying(null);
    setPhase(cards.length > 0 ? "cards" : "summary");
  };

  // Reverting an undone decision: back to whatever the row had before (usually nothing).
  // Mirrors the book page's invalidation set — never ["words", bookId], which would pull
  // new words into the frozen batch.
  const revert = useMutation({
    mutationFn: (d: { card: BookWordRow; status: UserWordStatus }) =>
      d.card.status === null
        ? clearWordStatus(d.card.word, language, "book")
        : setWordStatus(d.card.word, d.card.status, language, "book"),
    onSuccess: (_res, d) => {
      qc.invalidateQueries({ queryKey: ["book", bookId] });
      qc.invalidateQueries({ queryKey: ["review"] });
      onRestore(d.card.word);
    },
    onError: (err, d) => {
      // The server still holds the original decision — put the card back so the deck
      // agrees with it, the same way a failed mark un-hides its row on the book page.
      setDecisions((prev) => [...prev, d]);
      toast.error(errMessage(err, `Couldn't undo “${d.card.word}”.`));
    },
  });

  const canUndo =
    decisions.length > 0 && !undoSpent && !flying && !revert.isPending;

  const decide = (status: UserWordStatus) => {
    if (!card || flying) return;
    const decided = card;
    onDecide(decided.word, status); // fires immediately; the animation is just decoration
    setUndoSpent(false);
    setFlying(FLY[status]);
    flyTimer.current = window.setTimeout(
      () => {
        setDecisions((prev) => [...prev, { card: decided, status }]);
        setFlying(null);
        setDrag(null);
        setRevealed(false);
      },
      prefersReducedMotion() ? 0 : FLY_MS,
    );
  };

  const undo = () => {
    const last = decisions[decisions.length - 1];
    if (!last || !canUndo) return;
    setDecisions((prev) => prev.slice(0, -1));
    setUndoSpent(true);
    setRevealed(false);
    setPhase("cards");
    revert.mutate(last);
  };

  // ── Pointer drag ───────────────────────────────────────────────────────────
  // Capture is claimed only once the drag locks to the horizontal axis, so a vertical
  // pan keeps scrolling the card natively (`touch-action: pan-y` does the rest).
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (flying || !card) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // The revealed definition is interactive (note editor, AI buttons) — never a swipe.
    if ((e.target as HTMLElement).closest(".cm-reveal")) return;
    origin.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const o = origin.current;
    if (!o || o.id !== e.pointerId) return;
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;
    if (o.axis === null) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      o.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (o.axis === "x") e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (o.axis !== "x") return;
    setDrag({ dx, dy });
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>, commit: boolean) => {
    const o = origin.current;
    origin.current = null;
    if (!o || o.id !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (o.axis !== "x") return;
    const dx = e.clientX - o.x;
    const width = cardRef.current?.offsetWidth ?? 0;
    const dir = commit
      ? swipeDecision(dx, width, swipeVelocity(dx, e.timeStamp - o.t))
      : null;
    if (dir) decide(dir === "right" ? "known" : "learning");
    else setDrag(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
    if (e.key === "Escape") return onClose();
    if (phase !== "cards") return;
    if (e.key === "ArrowLeft") decide("learning");
    else if (e.key === "ArrowRight") decide("known");
    else if (e.key === "ArrowDown") decide("ignored");
    else if (e.key === " " || e.key === "Enter") setRevealed(true);
    else if (e.key === "u") undo();
    else return;
    e.preventDefault();
  };

  // ── Card transform ─────────────────────────────────────────────────────────
  const width = cardRef.current?.offsetWidth ?? 0;
  const dx = drag?.dx ?? 0;
  const style: React.CSSProperties = flying
    ? {
        transform:
          flying === "down"
            ? "translateY(120%)"
            : `translateX(${flying === "right" ? "120%" : "-120%"}) rotate(${
                flying === "right" ? MAX_TILT : -MAX_TILT
              }deg)`,
        opacity: 0,
      }
    : drag
      ? {
          transform: `translateX(${dx}px) rotate(${swipeTilt(dx, width)}deg)`,
          // The card must track the finger exactly; easing it would read as lag. Clearing
          // `drag` restores the transition, and that is what springs the card back.
          transition: "none",
        }
      : {};
  const stamp = drag ? swipeProgress(dx, width) : 0;

  const learningCards = decisions.filter((d) => d.status === "learning").map((d) => d.card);
  const lastDecision = decisions[index - 1];

  return (
    <div
      className="cm-root"
      role="dialog"
      aria-modal="true"
      aria-label="Card mode"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      {phase === "intro" && (
        <div className="cm-sheet">
          <h2>Card mode</h2>
          <p className="muted small">
            One word at a time, from the {rows.length.toLocaleString()} word
            {rows.length === 1 ? "" : "s"} in this batch. Swipe right for known, left for
            learning.
          </p>

          <div className="cm-settings">
            <div className="cm-setting">
              <span className="cm-setting-label">How many cards</span>
              <div className="cm-counts">
                {options.map((n) => {
                  const all = n === rows.length;
                  return (
                    <button
                      key={n}
                      className={`cm-count${all ? " all" : ""}${
                        n === selectedCount ? " active" : ""
                      }`}
                      aria-pressed={n === selectedCount}
                      onClick={() => setSettings({ ...settings, count: n })}
                    >
                      {all ? `All (${n})` : n}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="cm-sheet-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={selectedCount === 0}
              onClick={() => start(rows.slice(0, selectedCount))}
            >
              Start
            </button>
          </div>
        </div>
      )}

      {phase === "cards" && card && (
        <>
          <header className="cm-bar cm-top">
            <button className="cm-icon" onClick={onClose} aria-label="Exit card mode">
              ×
            </button>
            <div className="cm-progress">
              <div className="cm-progress-track">
                <span
                  className="cm-progress-fill"
                  style={{ width: `${(index / deck.length) * 100}%` }}
                />
              </div>
              <span className="muted small num">
                {index + 1}/{deck.length}
              </span>
            </div>
            <button className="btn ghost slim cm-undo" disabled={!canUndo} onClick={undo}>
              ↶ Undo
            </button>
          </header>

          <div className="cm-stage">
            <article
              className="cm-card"
              ref={cardRef}
              style={style}
              data-flying={flying ?? undefined}
            >
              {/* Stamps belong to the card frame, not the scrolling content — otherwise
                  they'd scroll out of view on a long definition. */}
              <span
                className="cm-stamp learning"
                style={{ opacity: dx < 0 ? stamp : 0 }}
                aria-hidden="true"
              >
                Learning
              </span>
              <span
                className="cm-stamp known"
                style={{ opacity: dx > 0 ? stamp : 0 }}
                aria-hidden="true"
              >
                Known
              </span>
              <div
                className="cm-card-scroll"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => endDrag(e, true)}
                onPointerCancel={(e) => endDrag(e, false)}
              >
                <CardModeCard
                  bookId={bookId}
                  card={card}
                  revealed={revealed}
                  onReveal={() => setRevealed(true)}
                />
              </div>
            </article>
          </div>

          <footer className="cm-bar cm-bottom">
            {ACTIONS.map((a) => (
              <button
                key={a.status}
                className={`btn ${a.cls}`}
                disabled={!!flying}
                onClick={() => decide(a.status)}
              >
                {a.label}
                <span className="cm-key" aria-hidden="true">
                  {a.hint}
                </span>
              </button>
            ))}
          </footer>
        </>
      )}

      {phase === "summary" && (
        <div className="cm-sheet">
          <h2>{deck.length > 0 ? "Deck finished" : "Nothing to review"}</h2>
          <div className="cm-tally">
            <span className="pill green">{tally.known} known</span>
            <span className="pill blue">{tally.learning} learning</span>
            <span className="pill gray">{tally.ignored} ignored</span>
          </div>
          <div className="cm-sheet-actions">
            {/* Misswiping the last card would otherwise land you here with no way back. */}
            {lastDecision && (
              <button className="btn ghost" disabled={!canUndo} onClick={undo}>
                ↶ Undo “{lastDecision.card.word}”
              </button>
            )}
            {learningCards.length > 0 && (
              <button className="btn" onClick={() => start(learningCards)}>
                Review the {learningCards.length} learning word
                {learningCards.length === 1 ? "" : "s"} again
              </button>
            )}
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
