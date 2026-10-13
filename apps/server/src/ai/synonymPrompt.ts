import { z } from "zod";

/**
 * Prompt + output contract for the AI synonyms call (spec 15). One flat list per word,
 * best first, at most {@link MAX_SYNONYMS} — and an empty list is a valid answer.
 */

export const MAX_SYNONYMS = 5;

/** Strict-mode structured outputs need a top-level object with every property required. */
export const AI_SYNONYMS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["synonyms"],
  properties: {
    synonyms: {
      type: "array",
      minItems: 0,
      maxItems: MAX_SYNONYMS,
      description:
        "Close synonyms of the word, the best and most common first. Empty when the word has no close synonym.",
      items: {
        type: "string",
        description: "One word or a short fixed phrase, in its base form.",
      },
    },
  },
} as const;

export interface AiSynonymsOutput {
  synonyms: string[];
}

/** Belt-and-braces over strict mode: some providers skip min/maxItems enforcement. */
export const aiSynonymsOutputSchema = z.object({
  synonyms: z.array(z.string()),
});

/** Same effort as the definition calls: a short-output task, no deep reasoning. */
export const SYNONYMS_PROVIDER_OPTS = { reasoning: { effort: "low" } } as const;

// As with the definition prompts, no count anywhere in the prose: a named cap reads as a
// target and the model pads up to it with near-misses. The cap lives only in the JSON
// schema and the server-side slice.
const SYSTEM_PROMPT = [
  "You are a lexicographer choosing synonyms for an English learner who is trying to understand a word they just met.",
  "Rules:",
  "- A synonym is a word or a short fixed phrase that can replace this word in an everyday sentence without changing what the sentence means.",
  "- The synonyms are there to help the learner understand the word, so none may be harder than it: never a rarer, more formal, more literary or more technical word. Prefer easier, more everyday words when they exist. For a word that is already basic, other basic words are the right synonyms.",
  "- Fewer is better than loose or harder. Give only true synonyms that are not harder than the word; if just one or two qualify, give just those, and if none do, give an empty list.",
  "- A broader word, a narrower word, a related word, an opposite or a definition is not a synonym. Leave them out.",
  "- Same part of speech as the word. No archaic or slang words.",
  "- Put the easiest and closest synonyms first. If the word has several common meanings, favor its main one.",
  "- Give each synonym in its base form, lowercase unless it is always capitalized. Never use the word itself or one of its forms, not even inside a phrase.",
].join("\n");

export interface SynonymsPromptInput {
  lemma: string;
  language: string;
  /** The word's CEFR level, when the bundled list has it — the ceiling for its synonyms. */
  level: string | null;
  /**
   * Sentences from one of the learner's books, already spread-selected. They only help
   * tell which meaning is the main one; the result is shared across every book.
   */
  examples: string[];
}

/** Build the (system, user) message pair for one word. */
export function buildSynonymsPrompt(p: SynonymsPromptInput): { system: string; user: string } {
  const contextBlock =
    p.examples.length > 0
      ? [
          "The sentences below show how the word is used in one of the learner's books. Use",
          "them only to tell which meaning matters most: the synonyms are shown wherever the",
          "learner meets this word, so they must fit the word in general, not just these sentences.",
          "",
          "<context_examples>",
          ...p.examples.map((s, i) => `${i + 1}. ${s}`),
          "</context_examples>",
        ].join("\n")
      : "No example sentences are available. Give synonyms for the word as it is generally used.";

  const user = [
    `Word: "${p.lemma}"`,
    `Language: ${p.language}`,
    ...(p.level
      ? [
          `CEFR level of the word: ${p.level}. No synonym above this level; basic A1-A2 words are always fine.`,
        ]
      : []),
    "",
    contextBlock,
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
}

const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];
/** Basic vocabulary never confuses: an A2 synonym is fine even for an A1 word. */
const ALWAYS_EASY = CEFR_ORDER.indexOf("A2");

/**
 * The guard behind the prompt's "never harder" rule: drops a one-word synonym whose CEFR
 * level is above the word's (and above A2), or that the CEFR list doesn't have at all
 * (the list covers the common vocabulary, so a word missing from it is a rare one).
 * Phrases and hyphenated words are not in the list and are kept. With no level for the
 * word itself there is nothing to compare against, and every synonym is kept.
 */
export function keepNoHarder(
  wordLevel: string | null,
  synonyms: string[],
  levels: Map<string, string>,
): string[] {
  const wordRank = wordLevel ? CEFR_ORDER.indexOf(wordLevel) : -1;
  if (wordRank < 0) return synonyms;
  const ceiling = Math.max(wordRank, ALWAYS_EASY);
  return synonyms.filter((s) => {
    const key = s.trim().toLowerCase();
    if (!/^\p{L}+$/u.test(key)) return true;
    const level = levels.get(key);
    if (!level) return false;
    const rank = CEFR_ORDER.indexOf(level);
    return rank >= 0 && rank <= ceiling;
  });
}

/**
 * The model's list, cleaned: trimmed, blanks dropped, and so is anything that contains
 * the word itself ("tell a lie" explains nothing about "lie"); duplicates removed
 * case-insensitively, capped at {@link MAX_SYNONYMS}. Order is kept — it is the model's
 * ranking.
 */
export function cleanSynonyms(lemma: string, raw: string[]): string[] {
  const self = lemma.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const value = s.trim().replace(/\s+/g, " ");
    const key = value.toLowerCase();
    if (!value || seen.has(key) || key.split(/[\s-]+/).includes(self)) continue;
    seen.add(key);
    out.push(value);
    if (out.length === MAX_SYNONYMS) break;
  }
  return out;
}
