import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearWordStatus,
  getWordDetail,
  setWordStatus,
  type UserWordStatus,
  type WordEventSource,
} from "../lib/api";
import { formSetOf, highlightForms } from "../lib/highlight";
import { LevelBadge, StatusBadge } from "./badges";
import { ModalOverlay } from "./ModalOverlay";
import { WordMeaning } from "./WordMeaning";

const ACTIONS: { status: UserWordStatus; label: string; cls: string }[] = [
  { status: "learning", label: "Learning", cls: "blue" },
  { status: "known", label: "Known", cls: "green" },
  { status: "ignored", label: "Ignore", cls: "gray" },
];

/** The bits the calling table already knows — lets the modal paint before the API responds. */
export interface WordModalInitial {
  word: string;
  level: string | null;
  count: number;
  status: UserWordStatus | null;
  example: string | null;
  /** Title of the book the context phrase was taken from (shown on the cross-book
   * vocabulary page, where a word may come from any of several books). */
  bookTitle?: string | null;
}

const errMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function WordModal({
  bookId,
  word,
  language,
  source,
  bookScoped,
  initial,
  onStatusChange,
  onClose,
}: {
  bookId: string;
  word: string;
  language: string;
  /** Which page opened the modal — drives the "learned" series. The book page is triage
   * (`book`); the Learning page is the deliberate study action (`learning`). */
  source: WordEventSource;
  /** A specific book is in context (the book page; or the vocabulary page filtered to one
   * book) → the user's own note replaces the dictionary definition. */
  bookScoped?: boolean;
  /** Row data shown instantly; the full detail (definition, note, forms) loads in parallel. */
  initial?: WordModalInitial;
  /** Called after a status change (mark or clear) succeeds. Lets a host with a frozen
   * review batch reconcile its own list — e.g. drop the row — WITHOUT this modal refetching
   * the host's word list, which would pull new words in mid-review. The modal deliberately
   * never invalidates `["words", …]`; the host owns that list and routes every triage
   * button (per-row and this modal) through one shared "freeze the batch" path. */
  onStatusChange?: (word: string, status: UserWordStatus | null) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["word", bookId, word],
    queryFn: () => getWordDetail(bookId, word),
  });

  // A status change touches this word's own detail, the book header counts, and the
  // cross-book vocabulary list — but deliberately NOT the host's ["words", …] batch, which
  // stays frozen. The host reconciles its own list via onStatusChange. This mirrors the
  // book page's per-row triage exactly, so no button (now or later) can reset the batch.
  const afterStatusChange = (status: UserWordStatus | null) => {
    qc.invalidateQueries({ queryKey: ["word", bookId, word] });
    qc.invalidateQueries({ queryKey: ["book", bookId] });
    qc.invalidateQueries({ queryKey: ["review"] });
    onStatusChange?.(word, status);
  };
  // Notes never change any word list — only this word's detail. Refresh just that, so saving
  // a note from the book page can't disturb the frozen review batch either.
  const refreshDetail = () => qc.invalidateQueries({ queryKey: ["word", bookId, word] });

  const d = detail.data;

  // Status shown on the buttons. Source of truth is the server (`d.status`), falling back
  // to the row data while the detail loads. `pending` is an optimistic override applied the
  // instant a button is clicked — so the UI never waits on the request. `undefined` = no
  // override; a status (or null) = optimistically applied, pending server confirmation.
  const serverStatus = d?.status ?? initial?.status ?? null;
  const [pending, setPending] = useState<UserWordStatus | null | undefined>(undefined);
  const effectiveStatus = pending !== undefined ? pending : serverStatus;

  // Once the (refetched) server truth matches what we optimistically applied, drop the
  // override so the server is authoritative again.
  useEffect(() => {
    if (pending !== undefined && d && (d.status ?? null) === pending) {
      setPending(undefined);
    }
  }, [d, pending]);

  const mark = useMutation({
    mutationFn: (status: UserWordStatus) => setWordStatus(word, status, language, source),
    // Reconcile only on success — a failed write must not drop the row from the host batch.
    onSuccess: (_data, status) => afterStatusChange(status),
    onError: (err) => {
      setPending(undefined); // reset the button to the server's actual state
      toast.error(errMessage(err, `Couldn't update “${word}”.`));
    },
  });
  const clear = useMutation({
    mutationFn: () => clearWordStatus(word, language, source),
    onSuccess: () => afterStatusChange(null),
    onError: (err) => {
      setPending(undefined);
      toast.error(errMessage(err, `Couldn't update “${word}”.`));
    },
  });

  // Apply the new status optimistically, then fire the request in parallel.
  const choose = (status: UserWordStatus) => {
    if (effectiveStatus === status) {
      setPending(null);
      clear.mutate();
    } else {
      setPending(status);
      mark.mutate(status);
    }
  };

  // Header fields fall back to the row data so they show before the detail request lands.
  const headWord = d?.word ?? initial?.word ?? word;
  const headLevel = d?.level ?? initial?.level ?? null;
  const headCount = d?.count ?? initial?.count ?? null;
  const headExample = d?.example ?? initial?.example ?? null;

  // The surface forms to bold in the context line: the lemma plus every form seen in
  // this book. Falls back to just the word until the detail (with forms) loads.
  const formSet = useMemo(
    () => formSetOf(word, headWord, ...(d?.forms.map((f) => f.word) ?? [])),
    [word, headWord, d?.forms],
  );

  return (
    <ModalOverlay onClose={onClose}>
      <button className="modal-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <div className="modal-body">
        <div className="modal-head">
          <h2>{headWord}</h2>
          {headLevel && <LevelBadge level={headLevel} />}
          {headCount != null && (
            <span className="count-chip">{headCount.toLocaleString()}×</span>
          )}
          <StatusBadge status={effectiveStatus} />
        </div>

        {headExample && (
          <p className="example">“{highlightForms(headExample, formSet)}”</p>
        )}
        {headExample && initial?.bookTitle && (
          <p className="example-source muted small">
            from <cite>{initial.bookTitle}</cite>
          </p>
        )}

        <div className="modal-section">
          <WordMeaning
            bookId={bookId}
            word={word}
            definition={d?.definition ?? null}
            note={d?.note ?? null}
            bookScoped={bookScoped}
            loading={detail.isLoading}
            onNoteSaved={refreshDetail}
          />
        </div>

        {d && d.forms.length > 1 && (
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
            const active = effectiveStatus === a.status;
            return (
              <button
                key={a.status}
                className={`btn ${a.cls}${active ? " active" : ""}`}
                title={active ? `Click to remove “${a.label}”` : undefined}
                onClick={() => choose(a.status)}
              >
                {active ? `✓ ${a.label}` : a.label}
              </button>
            );
          })}
        </div>
        {effectiveStatus && (
          <p className="muted small center action-hint">
            Click the highlighted button again to undo.
          </p>
        )}
      </div>
    </ModalOverlay>
  );
}
