import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  generateAiDefinition,
  type AiDefinitionStatus,
  type PaidFeatureSlug,
} from "../lib/api";
import { UsageLimitTip, useFeatureUsage, usageLimitMessage } from "./FeatureUsage";

const SLUG: PaidFeatureSlug = "ai-word-definition-from-context";

/**
 * The per-row twin of the modal's AI-definition button (`AiDefinitionSection`): request
 * a word's contextual definition straight from the book's word list, without opening
 * the modal and waiting on it. Fire-and-forget — the button is gone the moment the
 * request is sent, and stays gone once the list reports any state other than `failed`.
 */
export function AiDefinitionButton({
  bookId,
  word,
  aiStatus,
  enabled,
}: {
  bookId: string;
  word: string;
  /** From the word list: null = never requested; only `failed` can be retried. */
  aiStatus: AiDefinitionStatus | null;
  /** Server capability: false = no OpenRouter key configured → render nothing. */
  enabled: boolean;
}) {
  const qc = useQueryClient();
  // The loaded batch is frozen (never refetched mid-review), so the list's `aiStatus`
  // won't catch up on its own — this remembers that we asked.
  const [requested, setRequested] = useState(false);
  const canGenerate = enabled && !requested && (aiStatus === null || aiStatus === "failed");
  // Only consult the advisory usage endpoint while there is a button to gate.
  const usage = useFeatureUsage(SLUG, canGenerate);

  const generate = useMutation({
    mutationFn: () => generateAiDefinition(bookId, word),
    // Hide on click, not on the response.
    onMutate: () => setRequested(true),
    onError: (err) => {
      // 409 = already generated — nothing left to offer.
      if (err instanceof ApiError && err.status === 409) return;
      // The request didn't take, so offer the button again.
      setRequested(false);
      toast.error(err instanceof Error ? err.message : "Couldn't request the AI definition.");
    },
    // The modal for this word (if opened next) starts from fresh state + remaining usage.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["word", bookId, word] });
      qc.invalidateQueries({ queryKey: ["usage", SLUG] });
    },
  });

  if (!canGenerate) return null;

  const message = usageLimitMessage(usage.data);
  return (
    <UsageLimitTip message={message}>
      <button
        className="btn slim ai-row"
        title={aiStatus === "failed" ? "Try AI definition again" : "AI definition"}
        aria-label={`AI definition for ${word}`}
        onClick={() => generate.mutate()}
        disabled={!!message}
      >
        ✨ AI
      </button>
    </UsageLimitTip>
  );
}
