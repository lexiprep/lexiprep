import { describe, it, expect } from "vitest";
import { ADDED_OPTIONS, addedRange } from "../src/lib/addedRange";

const NOW = new Date(2026, 9, 11, 15, 30);

describe("addedRange", () => {
  it("has no bounds for any time or an unknown preset", () => {
    expect(addedRange("", NOW)).toEqual({});
    expect(addedRange("nonsense", NOW)).toEqual({});
  });

  it("bounds 'older' presets from above, at the start of the day", () => {
    expect(addedRange("older:12m", NOW)).toEqual({
      addedBefore: new Date(2025, 9, 11).toISOString(),
    });
    expect(addedRange("older:3m", NOW)).toEqual({
      addedBefore: new Date(2026, 6, 11).toISOString(),
    });
  });

  it("bounds 'within' presets from below", () => {
    expect(addedRange("within:7d", NOW)).toEqual({
      addedAfter: new Date(2026, 9, 4).toISOString(),
    });
  });

  it("resolves every offered preset", () => {
    for (const o of ADDED_OPTIONS.slice(1)) {
      expect(Object.keys(addedRange(o.value, NOW))).toHaveLength(1);
    }
  });
});
