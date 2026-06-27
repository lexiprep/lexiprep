import { format, parseISO } from "date-fns";
import type { Granularity, VocabularyTimeseries } from "./api";

export interface ChartRow {
  /** Raw bucket key (YYYY-MM-DD). */
  period: string;
  /** Words added in this bucket. */
  learningAdded: number;
  knownAdded: number;
  /** Words learned (learning → known, Learning page) in this bucket. */
  learnedAdded: number;
  /** Running totals from the baseline through this bucket. */
  learningTotal: number;
  knownTotal: number;
  learnedTotal: number;
}

/**
 * Turn a timeseries response into chart rows: keeps each bucket's "added" counts and
 * computes the cumulative running total starting from the pre-range baseline. Buckets are
 * assumed sorted ascending (the API returns them ordered).
 */
export function toChartRows(ts: VocabularyTimeseries): ChartRow[] {
  let learning = ts.baseline.learning;
  let known = ts.baseline.known;
  let learned = ts.baseline.learned;
  return ts.buckets.map((b) => {
    learning += b.learning;
    known += b.known;
    learned += b.learned;
    return {
      period: b.period,
      learningAdded: b.learning,
      knownAdded: b.known,
      learnedAdded: b.learned,
      learningTotal: learning,
      knownTotal: known,
      learnedTotal: learned,
    };
  });
}

/** Human label for a bucket key, by granularity (date-only, so no timezone shift). */
export function formatPeriodLabel(period: string, granularity: Granularity): string {
  const d = parseISO(period);
  if (granularity === "month") return format(d, "MMM yyyy");
  return format(d, "MMM d");
}

/** Quick presets for the date-range selector (days back from today, inclusive). */
export const RANGE_PRESETS: { label: string; days: number }[] = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
];
