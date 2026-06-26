import { describe, it, expect } from "vitest";
import { toChartRows, formatPeriodLabel } from "../src/lib/vocabStats";
import type { VocabularyTimeseries } from "../src/lib/api";

describe("toChartRows", () => {
  it("keeps per-bucket adds and accumulates totals from the baseline", () => {
    const ts: VocabularyTimeseries = {
      granularity: "day",
      baseline: { learning: 5, known: 10 },
      buckets: [
        { period: "2026-01-01", learning: 2, known: 1 },
        { period: "2026-01-02", learning: 0, known: 3 },
        { period: "2026-01-03", learning: 4, known: 0 },
      ],
    };
    expect(toChartRows(ts)).toEqual([
      { period: "2026-01-01", learningAdded: 2, knownAdded: 1, learningTotal: 7, knownTotal: 11 },
      { period: "2026-01-02", learningAdded: 0, knownAdded: 3, learningTotal: 7, knownTotal: 14 },
      { period: "2026-01-03", learningAdded: 4, knownAdded: 0, learningTotal: 11, knownTotal: 14 },
    ]);
  });

  it("returns an empty array when there are no buckets", () => {
    const ts: VocabularyTimeseries = {
      granularity: "week",
      baseline: { learning: 0, known: 0 },
      buckets: [],
    };
    expect(toChartRows(ts)).toEqual([]);
  });

  it("starts cumulative totals at zero when the baseline is empty", () => {
    const ts: VocabularyTimeseries = {
      granularity: "month",
      baseline: { learning: 0, known: 0 },
      buckets: [{ period: "2026-02-01", learning: 3, known: 2 }],
    };
    const [row] = toChartRows(ts);
    expect(row).toMatchObject({ learningTotal: 3, knownTotal: 2 });
  });
});

describe("formatPeriodLabel", () => {
  it("formats day/week buckets as 'MMM d'", () => {
    expect(formatPeriodLabel("2026-01-05", "day")).toBe("Jan 5");
    expect(formatPeriodLabel("2026-03-09", "week")).toBe("Mar 9");
  });

  it("formats month buckets as 'MMM yyyy'", () => {
    expect(formatPeriodLabel("2026-01-01", "month")).toBe("Jan 2026");
  });
});
