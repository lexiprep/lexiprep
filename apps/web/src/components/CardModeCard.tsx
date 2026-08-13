import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWordDetail, type BookWordRow } from "../lib/api";
import { formSetOf, highlightForms } from "../lib/highlight";
import { AiDefinitionSection } from "./AiDefinitionSection";
import { LevelBadge, StatusBadge } from "./badges";
import { WordMeaning } from "./WordMeaning";

/**
 * The face of one card: the word, how often it appears, and the sentence it was pulled
 * from — and nothing else until you ask. The definition is deliberately withheld so the
 * card tests recall against the context first; only `Show definition` fetches it.
 *
 * The reveal lives inside `.cm-reveal`, which CardMode's pointer handler treats as a
 * no-swipe zone so the note editor and AI buttons stay usable mid-deck.
 */
export function CardModeCard({
  bookId,
  card,
  revealed,
  onReveal,
}: {
  bookId: string;
  card: BookWordRow;
  revealed: boolean;
  onReveal: () => void;
}) {
  const qc = useQueryClient();
  // Same query key as WordModal, so a word opened from the table is already in cache.
  // `enabled` is the whole point: no request goes out until the user reveals.
  const detail = useQuery({
    queryKey: ["word", bookId, card.word],
    queryFn: () => getWordDetail(bookId, card.word),
    enabled: revealed,
    refetchInterval: (q) =>
      q.state.data?.aiDefinition?.status === "pending" ? 1500 : false,
  });
  const d = detail.data;

  // Bold the lemma plus every form seen in this book — falls back to the lemma alone
  // until the detail loads (and forever, if the card was never revealed).
  const formSet = useMemo(
    () => formSetOf(card.word, d?.word, ...(d?.forms.map((f) => f.word) ?? [])),
    [card.word, d?.word, d?.forms],
  );

  return (
    <>
      <div className="cm-word">
        <h2>{card.word}</h2>
        <LevelBadge level={card.level} />
        <span className="count-chip">{card.count.toLocaleString()}×</span>
        {card.status && <StatusBadge status={card.status} />}
      </div>

      {card.example ? (
        <p className="example cm-example">
          “{highlightForms(card.example, formSet)}”
        </p>
      ) : (
        <p className="muted small cm-example">No context sentence for this word.</p>
      )}

      {!revealed ? (
        <button className="btn cm-reveal-btn" onClick={onReveal}>
          Show definition
        </button>
      ) : (
        <div className="cm-reveal">
          <WordMeaning
            bookId={bookId}
            word={card.word}
            definition={d?.definition ?? null}
            notes={d?.notes ?? []}
            aiSenses={d?.aiDefinition?.status === "done" ? d.aiDefinition.senses : null}
            bookScoped
            loading={detail.isLoading}
            onNotesChanged={() =>
              qc.invalidateQueries({ queryKey: ["word", bookId, card.word] })
            }
          />
          {/* AI controls only while you have no definition of your own — yours outranks
              the AI one, so offering to generate it would be noise (mirrors WordModal). */}
          {d && d.notes.length === 0 && (
            <AiDefinitionSection
              bookId={bookId}
              word={card.word}
              aiDefinition={d.aiDefinition}
              enabled={d.aiDefinitionEnabled}
              bookScoped
            />
          )}
        </div>
      )}
    </>
  );
}
