import { z } from "zod";

/**
 * Prompt + output contract for the AI contextual-definition call. The model returns
 * structured JSON (OpenRouter strict json_schema — no ";"-splitting of free text), at
 * most {@link MAX_MEANINGS} meanings, each a short learner-friendly phrase with a POS.
 */

export const MAX_MEANINGS = 3;

/** POS values the model may emit (mirrors the labels the dictionary senses use). */
const POS_VALUES = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "preposition",
  "conjunction",
  "pronoun",
  "determiner",
  "interjection",
  "other",
] as const;

/** Strict-mode structured outputs need a top-level object with every property required. */
export const AI_DEFINITION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["meanings"],
  properties: {
    meanings: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MEANINGS,
      description:
        "One entry per genuinely different meaning - a single entry is the norm. The meaning most relevant to the book first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pos", "meaning"],
        properties: {
          pos: { type: "string", enum: [...POS_VALUES] },
          meaning: {
            type: "string",
            description:
              "A short, simple definition of about 5-12 plain words, for an advanced English learner.",
          },
        },
      },
    },
  },
} as const;

export interface AiMeaning {
  pos: string;
  meaning: string;
}
export interface AiDefinitionOutput {
  meanings: AiMeaning[];
}

/** Belt-and-braces over strict mode: some providers skip min/maxItems enforcement. */
export const aiDefinitionOutputSchema = z.object({
  meanings: z
    .array(
      z.object({
        pos: z.string().trim().min(1),
        meaning: z.string().trim().min(1),
      }),
    )
    .min(1),
});

/**
 * Low-effort thinking: the model gets context sentences worth a quick read-through
 * before committing to meanings, but this is a short-output task — no deep reasoning.
 */
export const DEFINITION_PROVIDER_OPTS = { reasoning: { effort: "low" } } as const;

export interface DefinitionPromptInput {
  lemma: string;
  /** Surface forms of the lemma appearing in this book (conjugations/inflections). */
  forms: string[];
  bookTitle: string;
  bookAuthor: string | null;
  language: string;
  /** Up to 5 sentences, already spread-selected across the text. May be empty. */
  examples: string[];
}

// Deliberately no meaning-count anywhere in the prose: models treat a named cap as a
// target and pad with paraphrases ("discern" once came back as three shades of
// "perceive"). The hard cap lives only in the JSON schema + the server-side slice.
const SYSTEM_PROMPT = [
  "You are a lexicographer writing very short word definitions for an advanced English learner.",
  "Rules:",
  "- Most words are used one way: give exactly ONE meaning. Add another only when the word has a genuinely unrelated second meaning (a different part of speech, or a completely different sense - like 'bank': river edge vs. money institution).",
  "- Never restate the same meaning in different words. If two candidate meanings overlap, merge them into one.",
  "- Each meaning is one short, simple phrase of about 5-12 words, in plain everyday language. No jargon, no circular definitions.",
  "- Give the part of speech for each meaning.",
  "- Include only meanings that are plausible for this word in general usage - never invent rare senses.",
  "- Put the meaning most relevant to the book's context first.",
].join("\n");

/** Build the (system, user) message pair for one word in one book. */
export function buildDefinitionPrompt(p: DefinitionPromptInput): {
  system: string;
  user: string;
} {
  const forms = [...new Set([p.lemma, ...p.forms])];
  const contextBlock =
    p.examples.length > 0
      ? [
          "The sentences below are a small sample of how the word appears in this book — a",
          "few from the beginning, middle and end. They are examples only: use them to pick",
          "the most relevant meaning, but consider the word's broader meanings too, not just",
          "these specific uses.",
          "",
          "<context_examples>",
          ...p.examples.map((s, i) => `${i + 1}. ${s}`),
          "</context_examples>",
        ].join("\n")
      : "No example sentences are available for this book.";

  const user = [
    `Word: "${p.lemma}"`,
    `Forms of this word appearing in the book: ${forms.join(", ")}`,
    `Book: "${p.bookTitle}" by ${p.bookAuthor ?? "an unknown author"} (language: ${p.language})`,
    "",
    contextBlock,
  ].join("\n");

  return { system: SYSTEM_PROMPT, user };
}
