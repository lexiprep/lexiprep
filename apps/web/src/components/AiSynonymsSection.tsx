import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, generateAiSynonyms, type AiSynonyms, type PaidFeatureSlug } from "../lib/api";
import { UsageLimitTip, useFeatureUsage, usageLimitMessage } from "./FeatureUsage";

const SLUG: PaidFeatureSlug = "ai-word-synonyms";

/**
 * The word modal's Synonyms section (spec 15): the word's AI synonyms, shared across
 * books. The modal shows it only once the word has a meaning to read first (an AI one,
 * or the user's own). New AI definitions bring their synonyms on their own; the button
 * is for words defined before synonyms existed, and for a failed attempt.
 */
export function AiSynonymsSection({
  bookId,
  word,
  language = "en",
  aiSynonyms,
  enabled,
}: {
  /** The book in context — lends its sentences to the prompt and keys the detail query. */
  bookId: string;
  word: string;
  language?: string;
  aiSynonyms: AiSynonyms | null;
  /** Server capability: false = no OpenRouter key configured → no button. */
  enabled: boolean;
}) {
  const qc = useQueryClient();
  // Until the refetch brings the server's `pending`, remember that we asked, so the
  // button can't be fired twice (same as the AI definition button).
  const [requested, setRequested] = useState(false);
  const status = aiSynonyms?.status ?? (requested ? "pending" : null);
  useEffect(() => {
    if (aiSynonyms) setRequested(false);
  }, [aiSynonyms]);

  const canGenerate = enabled && (status === null || status === "failed");
  const usage = useFeatureUsage(SLUG, canGenerate);

  const generate = useMutation({
    mutationFn: () => generateAiSynonyms(word, language, bookId),
    onMutate: () => setRequested(true),
    onError: (err) => {
      // 409 = they already exist — the refetch below shows them.
      if (err instanceof ApiError && err.status === 409) return;
      setRequested(false);
      toast.error(err instanceof Error ? err.message : "Couldn't request the synonyms.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["word", bookId, word] });
      qc.invalidateQueries({ queryKey: ["usage", SLUG] });
    },
  });

  const heading = (
    <h4>
      Synonyms <span className="ai-badge">AI</span>
    </h4>
  );

  if (status === "done") {
    const synonyms = aiSynonyms?.synonyms ?? [];
    return (
      <div className="modal-section ai-synonyms">
        {heading}
        {synonyms.length > 0 ? (
          <p className="synonyms">
            {synonyms.map((s) => (
              <span key={s} className="synonym">
                {s}
              </span>
            ))}
          </p>
        ) : (
          <p className="muted small">No close synonyms for this word.</p>
        )}
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div className="modal-section ai-synonyms">
        {heading}
        <p className="muted small">Finding synonyms…</p>
      </div>
    );
  }

  if (!enabled) return null;

  const message = usageLimitMessage(usage.data);
  const failed = status === "failed";
  return (
    <div className="modal-section ai-synonyms">
      {failed && (
        <p className="muted small">AI synonyms failed: {aiSynonyms?.error ?? "unknown error"}</p>
      )}
      <UsageLimitTip message={message}>
        <button
          className="btn"
          onClick={() => generate.mutate()}
          disabled={generate.isPending || !!message}
        >
          {generate.isPending ? "Requesting…" : failed ? "Try AI synonyms again" : "✨ AI synonyms"}
        </button>
      </UsageLimitTip>
    </div>
  );
}
