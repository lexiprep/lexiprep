import { describe, it, expect } from "vitest";
import { ago } from "../src/lib/ago";

const now = new Date(2026, 9, 5, 15, 0, 0);
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe("ago", () => {
  it("counts calendar days, not 24-hour spans", () => {
    expect(ago(at(2026, 9, 5, 1), now)).toBe("today");
    expect(ago(at(2026, 9, 4, 23), now)).toBe("yesterday");
    expect(ago(at(2026, 9, 1), now)).toBe("4 days ago");
  });

  it("widens to weeks, months and years", () => {
    expect(ago(at(2026, 8, 14), now)).toBe("3 weeks ago");
    expect(ago(at(2026, 5, 5), now)).toBe("4 months ago");
    expect(ago(at(2025, 9, 1), now)).toBe("a year ago");
    expect(ago(at(2023, 9, 1), now)).toBe("3 years ago");
  });

  it("never reports the future", () => {
    expect(ago(at(2026, 9, 6), now)).toBe("today");
  });
});
