// CEFR levels. Text order (A1<A2<B1<B2<C1<C2) matches difficulty, so the server can
// sort/filter on the column directly.
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

// Color cue per band so the table reads at a glance (cool = easy, warm = hard).
export const LEVEL_COLOR: Record<string, string> = {
  A1: "#1a7f5a",
  A2: "#3a8f3a",
  B1: "#9a8a1a",
  B2: "#b9761f",
  C1: "#c2521f",
  C2: "#a32020",
};

/**
 * Short label for a CEFR from–to range, e.g. "A2–B1", "B1+", "≤B2", "unleveled", or ""
 * for no bounds. The `none` sentinel (unleveled — names / rare words) renders as "—".
 */
export function levelRangeLabel(from?: string, to?: string): string {
  const f = from === "none" ? "—" : from;
  const t = to === "none" ? "—" : to;
  if (from && to) return from === to ? (from === "none" ? "unleveled" : from) : `${f}–${t}`;
  if (from) return from === "none" ? "— and up" : `${from}+`;
  if (to) return to === "none" ? "unleveled" : `≤${to}`;
  return "";
}
