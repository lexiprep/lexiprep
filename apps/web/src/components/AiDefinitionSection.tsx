import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  generateAiDefinition,
  generateGeneralAiDefinition,
  type AiDefinition,
  type PaidFeatureSlug,
} from "../lib/api";
import { UsageLimitTip, useFeatureUsage, usageLimitMessage } from "./FeatureUsage";

const BOOK_SLUG: PaidFeatureSlug = "ai-word-definition-from-context";
const GENERAL_SLUG: PaidFeatureSlug = "ai-word-definition-general";

/**
 * The AI-definition *controls* in the word modal (spec 10/13): the generate button,
 * the "generating…" status, and the failed + retry state. The generated meanings
 * themselves render inside `WordMeaning` (they replace the dictionary for this book),
 * so a `done` definition renders nothing here. One immutable generation per
 * (book, word): only a `failed` attempt can be retried — regenerating a good
 * definition would just burn tokens on the same prompt.
 */
export function AiDefinitionSection({
  bookId,
  word,
  language = "en",
  aiDefinition,
  enabled,
  bookScoped,
}: {
  bookId: string;
  word: string;
  language?: string;
  /**
   * The relevant definition's state: the book's contextual one inside a book, the
   * word's own (book-independent) one everywhere else. The caller picks which.
   */
  aiDefinition: AiDefinition | null;
  /** Server capability: false = no OpenRouter key configured → render nothing. */
  enabled: boolean;
  /**
   * A book is in context → generate the contextual definition from its sentences.
   * Otherwise generate the context-free one: the word's own meanings, no book.
   */
  bookScoped?: boolean;
}) {
  const qc = useQueryClient();
  // The server's `pending` only reaches us on the next word-detail fetch, and that
  // request can be slow (it may be waiting on the dictionary API). Until it lands, this
  // remembers that we asked — otherwise the button stays live and invites a second
  // click on a request that is already running.
  const [requested, setRequested] = useState(false);
  const status = aiDefinition?.status ?? (requested ? "pending" : null);
  // Once the server reports any state of its own, it is authoritative again.
  useEffect(() => {
    if (aiDefinition) setRequested(false);
  }, [aiDefinition]);

  const canGenerate = enabled && (status === null || status === "failed");
  const slug = bookScoped ? BOOK_SLUG : GENERAL_SLUG;
  // Only consult the advisory usage endpoint while there is a button to gate.
  const usage = useFeatureUsage(slug, canGenerate);

  const generate = useMutation({
    mutationFn: () =>
      bookScoped
        ? generateAiDefinition(bookId, word)
        : generateGeneralAiDefinition(word, language),
    // Flip to "generating" on click, not on the refetch that may be seconds away.
    onMutate: () => setRequested(true),
    onError: (err) => {
      // 409 = someone already generated it — the refetch below shows the result.
      if (err instanceof ApiError && err.status === 409) return;
      // The request didn't take, so offer the button again.
      setRequested(false);
      toast.error(err instanceof Error ? err.message : "Couldn't request the AI definition.");
    },
    // Either way, refresh the word detail (starts the pending poll) + remaining usage.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["word", bookId, word] });
      qc.invalidateQueries({ queryKey: ["usage", slug] });
    },
  });

  if (!enabled) return null;

  // Done → the meanings render inside WordMeaning (per-book replacement); nothing here.
  if (status === "done") return null;

  if (status === "pending") {
    return (
      <div className="modal-section ai-definition">
        <h4>
          AI definition <span className="ai-badge">AI</span>
        </h4>
        <p className="muted small">
          {bookScoped ? "Generating from this book’s context…" : "Generating the word’s meanings…"}
        </p>
      </div>
    );
  }

  const message = usageLimitMessage(usage.data);
  const failed = status === "failed";
  return (
    <div className="modal-section ai-definition">
      {failed && (
        <p className="muted small">AI definition failed: {aiDefinition?.error ?? "unknown error"}</p>
      )}
      <UsageLimitTip message={message}>
        <button
          className="btn"
          onClick={() => generate.mutate()}
          disabled={generate.isPending || !!message}
        >
          {generate.isPending
            ? "Requesting…"
            : failed
              ? "Try AI definition again"
              : bookScoped
                ? "✨ AI definition"
                : "✨ AI meanings"}
        </button>
      </UsageLimitTip>
    </div>
  );
}
