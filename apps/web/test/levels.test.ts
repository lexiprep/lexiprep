import { describe, it, expect } from "vitest";
import { CEFR_LEVELS, LEVEL_COLOR, levelRangeLabel } from "../src/lib/levels";

describe("CEFR_LEVELS / LEVEL_COLOR", () => {
  it("lists the six bands in increasing difficulty order", () => {
    expect(CEFR_LEVELS).toEqual(["A1", "A2", "B1", "B2", "C1", "C2"]);
  });

  it("has a color for every band", () => {
    for (const lvl of CEFR_LEVELS) {
      expect(LEVEL_COLOR[lvl]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("levelRangeLabel", () => {
  it("renders a full range", () => {
    expect(levelRangeLabel("A2", "B1")).toBe("A2–B1");
  });

  it("collapses an equal from/to to the single level", () => {
    expect(levelRangeLabel("B1", "B1")).toBe("B1");
  });

  it("labels a from-only bound as 'X+'", () => {
    expect(levelRangeLabel("B1", undefined)).toBe("B1+");
  });

  it("labels a to-only bound as '≤X'", () => {
    expect(levelRangeLabel(undefined, "B2")).toBe("≤B2");
  });

  it("returns an empty string with no bounds", () => {
    expect(levelRangeLabel(undefined, undefined)).toBe("");
  });

  it("handles the `none` (unleveled) sentinel", () => {
    expect(levelRangeLabel("none", "none")).toBe("unleveled");
    expect(levelRangeLabel("none", undefined)).toBe("— and up");
    expect(levelRangeLabel(undefined, "none")).toBe("unleveled");
    expect(levelRangeLabel("none", "B1")).toBe("—–B1");
  });
});
