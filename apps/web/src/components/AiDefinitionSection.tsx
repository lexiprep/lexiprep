import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  generateAiDefinition,
  type AiDefinition,
  type PaidFeatureSlug,
} from "../lib/api";
import { UsageLimitTip, useFeatureUsage, usageLimitMessage } from "./FeatureUsage";

const SLUG: PaidFeatureSlug = "ai-word-definition-from-context";

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
  aiDefinition,
  enabled,
  bookScoped,
}: {
  bookId: string;
  word: string;
  aiDefinition: AiDefinition | null;
  /** Server capability: false = no OpenRouter key configured → render nothing. */
  enabled: boolean;
  /** Only a book-scoped modal can generate (the definition is contextual to a book). */
  bookScoped?: boolean;
}) {
  const qc = useQueryClient();
  const canGenerate =
    enabled && !!bookScoped && (aiDefinition === null || aiDefinition.status === "failed");
  // Only consult the advisory usage endpoint while there is a button to gate.
  const usage = useFeatureUsage(SLUG, canGenerate);

  const generate = useMutation({
    mutationFn: () => generateAiDefinition(bookId, word),
    onError: (err) => {
      // 409 = someone already generated it — the refetch below shows the result.
      if (err instanceof ApiError && err.status === 409) return;
      toast.error(err instanceof Error ? err.message : "Couldn't request the AI definition.");
    },
    // Either way, refresh the word detail (starts the pending poll) + remaining usage.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["word", bookId, word] });
      qc.invalidateQueries({ queryKey: ["usage", SLUG] });
    },
  });

  if (!enabled) return null;

  // Done → the meanings render inside WordMeaning (per-book replacement); nothing here.
  if (aiDefinition?.status === "done") return null;

  if (aiDefinition?.status === "pending") {
    return (
      <div className="modal-section ai-definition">
        <h4>
          AI definition <span className="ai-badge">AI</span>
        </h4>
        <p className="muted small">Generating from this book’s context…</p>
      </div>
    );
  }

  if (!bookScoped) return null;

  const message = usageLimitMessage(usage.data);
  const failed = aiDefinition?.status === "failed";
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
              : "✨ AI definition"}
        </button>
      </UsageLimitTip>
    </div>
  );
}
