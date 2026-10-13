/**
 * Registry of usage-metered / paid features (spec 13). The slug is the stable
 * identifier used everywhere — the guard, the two FE-facing endpoints, and the
 * `feature_limits` policy rows. Slugs live in code (this const is the source of
 * truth + gives type safety); the numeric limits live in the DB and are adjusted
 * via migrations. Adding a feature = add a slug here (no DB migration needed to
 * *register* it; a migration only seeds/changes its limits).
 */
export const PAID_FEATURES = [
  "ai-word-definition-from-context",
  "ai-word-definition-general",
  "ai-word-synonyms",
] as const;

export type PaidFeatureSlug = (typeof PAID_FEATURES)[number];

export interface FeatureMeta {
  /** Human label for the FE catalogue. */
  label: string;
  description: string;
  /**
   * True when a real endpoint enforces this slug — such a feature is expected to
   * have at least one seeded `feature_limits` row (a test asserts this so we can't
   * ship an ungated paid feature by forgetting the policy). Unconfigured features
   * are otherwise fail-open (unlimited).
   */
  enforced: boolean;
}

export const FEATURE_META: Record<PaidFeatureSlug, FeatureMeta> = {
  "ai-word-definition-from-context": {
    label: "AI contextual definition",
    description: "Explains a word using the sentence it appears in.",
    enforced: true,
  },
  "ai-word-definition-general": {
    label: "AI word meanings",
    description: "Explains a word on its own, with no book in context.",
    enforced: true,
  },
  "ai-word-synonyms": {
    label: "AI synonyms",
    description: "Up to five close synonyms for a word.",
    enforced: true,
  },
};

/** Type guard: is `v` a known paid-feature slug? */
export function isPaidFeature(v: unknown): v is PaidFeatureSlug {
  return typeof v === "string" && (PAID_FEATURES as readonly string[]).includes(v);
}

/** The AI contextual-definition pipeline's slug (routes, trigger service, worker). */
export const AI_DEFINITION_SLUG: PaidFeatureSlug = "ai-word-definition-from-context";

/**
 * The context-free pipeline's slug. Metered separately: it is the cheaper call (no book
 * context to assemble or send) and its result is shared by every user, so it shouldn't
 * eat the contextual feature's budget.
 */
export const AI_GENERAL_DEFINITION_SLUG: PaidFeatureSlug = "ai-word-definition-general";

/**
 * The synonyms pipeline's slug. Its own budget: synonyms are requested on their own
 * after every AI definition, so sharing a slug would halve what a review batch can define.
 */
export const AI_SYNONYMS_SLUG: PaidFeatureSlug = "ai-word-synonyms";
