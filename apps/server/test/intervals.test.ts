import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  formatInterval,
  newCard,
  nextReview,
  previewIntervals,
  type CardState,
  type IntervalConfig,
  type Rating,
} from "../src/review/intervals.js";

// A fixed clock — the module is pure, so the wall time never matters; only deltas do.
const NOW = new Date("2026-06-30T12:00:00.000Z");
// Fuzz off → deterministic, exact core-math assertions. Separate tests cover fuzz.
const NO_FUZZ: IntervalConfig = { ...DEFAULT_CONFIG, fuzz: false };

const MIN = 60_000;
const DAY = 86_400_000;

/** Build a review-phase card from the default fresh card. */
function reviewCard(over: Partial<CardState> = {}): CardState {
  return { ...newCard(), state: "review", ...over };
}

function grade(card: CardState, g: Rating, cfg: IntervalConfig = NO_FUZZ) {
  return nextReview(card, g, NOW, "seed", cfg);
}

describe("newCard", () => {
  it("returns the spec's initial per-card state", () => {
    expect(newCard()).toEqual({
      state: "new",
      intervalDays: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
      step: 0,
      streak: 0,
      due: null,
      lastReviewed: null,
      preLapseInterval: 0,
    });
  });
});

describe("DEFAULT_CONFIG", () => {
  it("carries the spec constants verbatim", () => {
    expect(DEFAULT_CONFIG.learningSteps).toEqual([1, 10]);
    expect(DEFAULT_CONFIG.relearningSteps).toEqual([10]);
    expect(DEFAULT_CONFIG.graduatingInterval).toBe(1);
    expect(DEFAULT_CONFIG.easyInterval).toBe(4);
    expect(DEFAULT_CONFIG.startingEase).toBe(2.5);
    expect(DEFAULT_CONFIG.hardFactor).toBe(0.25); // the load-bearing divergence
    expect(DEFAULT_CONFIG.lapseFactor).toBe(0);
    expect(DEFAULT_CONFIG.autoGraduateKnown).toBe(false);
    expect(DEFAULT_CONFIG.knownIntervalDays).toBe(365);
    expect(DEFAULT_CONFIG.knownStreak).toBe(3);
  });
});

describe("new card → Good path (spec worked example)", () => {
  it("Good → 10m learning step → Good → graduate 1d → 3d → 8d → 20d", () => {
    let card = newCard();

    // Good on a new card → first learning step is consumed; reshow in 10m.
    let r = grade(card, 3);
    expect(r.card.state).toBe("learning");
    expect(r.card.step).toBe(1);
    expect(r.card.intervalDays).toBe(0);
    expect(r.card.due!.getTime() - NOW.getTime()).toBe(10 * MIN);
    expect(r.log.intervalAfter).toBe(0); // sub-day step logs intervalAfter = 0
    card = r.card;

    // Good on the last step → graduate to review at the 1d graduating interval.
    r = grade(card, 3);
    expect(r.card.state).toBe("review");
    expect(r.card.intervalDays).toBe(1);
    expect(r.card.reps).toBe(1);
    expect(r.card.streak).toBe(1);
    expect(r.card.due!.getTime() - NOW.getTime()).toBe(1 * DAY);
    card = r.card;

    // Review Goods: 1×2.5≈3 → 3×2.5≈8 → 8×2.5=20 (rounded compounding).
    r = grade(card, 3);
    expect(r.card.intervalDays).toBe(3);
    card = r.card;

    r = grade(card, 3);
    expect(r.card.intervalDays).toBe(8);
    card = r.card;

    r = grade(card, 3);
    expect(r.card.intervalDays).toBe(20);
  });
});

describe("Easy on the first showing", () => {
  it("skips the learning steps straight to the 4d easy interval", () => {
    const r = grade(newCard(), 4);
    expect(r.card.state).toBe("review");
    expect(r.card.intervalDays).toBe(4);
    expect(r.card.reps).toBe(1);
    expect(r.card.due!.getTime() - NOW.getTime()).toBe(4 * DAY);
  });
});

describe("Good ladder at ease 2.5 (spec ≈ 2.5^reps)", () => {
  it("compounds the rounded interval: 3, 8, 20, 50, 125, 313, 783", () => {
    // The spec cites a continuous ≈ 2.5^reps ladder (2.5, 6, 16, 39, 98, 244, 610); the
    // owned implementation rounds each step and compounds the rounded value (per the spec's
    // authoritative worked path 1→3→8→20), so the integer ladder sits slightly higher.
    let card = reviewCard({ intervalDays: 1, ease: 2.5, reps: 1 });
    for (const expected of [3, 8, 20, 50, 125, 313, 783]) {
      const r = grade(card, 3);
      expect(r.card.intervalDays).toBe(expected);
      card = r.card;
    }
  });
});

describe("Easy → 1 month → Hard demotion (the owner's scenario)", () => {
  it("Hard shortens a 30d/2.6 card to 8d and drops ease to 2.45", () => {
    const card = reviewCard({ intervalDays: 30, ease: 2.6, reps: 5, streak: 5 });
    const r = grade(card, 2); // Hard
    expect(r.card.intervalDays).toBe(8); // round(30 × 0.25) = round(7.5) = 8
    expect(r.card.ease).toBeCloseTo(2.45, 10);
    expect(r.card.streak).toBe(0); // Hard zeroes the streak
    expect(r.card.state).toBe("review");
    expect(r.log.scheduledDays).toBe(30);
  });

  it("Again on the same card instead fully resets via the lapse path to 1d", () => {
    const card = reviewCard({ intervalDays: 30, ease: 2.6, reps: 5, streak: 5 });

    const lapse = grade(card, 1); // Again → relearning
    expect(lapse.card.state).toBe("relearning");
    expect(lapse.card.lapses).toBe(1);
    expect(lapse.card.preLapseInterval).toBe(30);
    expect(lapse.card.streak).toBe(0);
    expect(lapse.card.intervalDays).toBe(0);
    expect(lapse.card.due!.getTime() - NOW.getTime()).toBe(10 * MIN);
    expect(lapse.card.ease).toBeCloseTo(2.4, 10); // 2.6 − 0.20

    const relearned = grade(lapse.card, 3); // Good in relearning → graduate
    expect(relearned.card.state).toBe("review");
    expect(relearned.card.intervalDays).toBe(1); // max(1, round(30 × 0)) = 1
  });
});

describe("ease bounds", () => {
  it("clamps ease at the floor on repeated Again lapses", () => {
    let card = reviewCard({ intervalDays: 10, ease: 1.4 });
    const r = grade(card, 1); // 1.4 − 0.20 = 1.20 → clamped to EASE_MIN 1.3
    expect(r.card.ease).toBeCloseTo(1.3, 10);
  });

  it("clamps ease at the ceiling on Easy", () => {
    const card = reviewCard({ intervalDays: 10, ease: 2.95 });
    const r = grade(card, 4); // 2.95 + 0.15 = 3.10 → clamped to EASE_MAX 3.0
    expect(r.card.ease).toBeCloseTo(3.0, 10);
  });
});

describe("review log", () => {
  it("records elapsed/scheduled/after for a review-phase grade", () => {
    const card = reviewCard({
      intervalDays: 10,
      ease: 2.5,
      lastReviewed: new Date(NOW.getTime() - 5 * DAY),
    });
    const r = grade(card, 3); // Good
    expect(r.log).toEqual({
      rating: 3,
      stateBefore: "review",
      elapsedDays: 5,
      scheduledDays: 10,
      intervalAfter: 25, // round(10 × 2.5)
      easeAfter: 2.5,
    });
  });

  it("logs elapsed 0 and intervalAfter 0 for a brand-new sub-day step", () => {
    const r = grade(newCard(), 3);
    expect(r.log.elapsedDays).toBe(0);
    expect(r.log.scheduledDays).toBe(0);
    expect(r.log.intervalAfter).toBe(0);
  });
});

describe("fuzz", () => {
  it("is deterministic: same (card, grade, now, seed) → identical result", () => {
    const card = reviewCard({ intervalDays: 100, ease: 2.5, reps: 5, streak: 5 });
    const a = nextReview(card, 3, NOW, "card-1:1719748800", DEFAULT_CONFIG);
    const b = nextReview(card, 3, NOW, "card-1:1719748800", DEFAULT_CONFIG);
    expect(a.card.intervalDays).toBe(b.card.intervalDays);
    expect(a.card.due!.getTime()).toBe(b.card.due!.getTime());
  });

  it("the preview label equals what nextReview actually schedules (same seed)", () => {
    const card = reviewCard({ intervalDays: 100, ease: 2.5, reps: 5, streak: 5 });
    const seed = "card-1:1719748800";
    const preview = previewIntervals(card, NOW, seed, DEFAULT_CONFIG);
    for (const [g, key] of [
      [1, "again"],
      [2, "hard"],
      [3, "good"],
      [4, "easy"],
    ] as const) {
      const { card: graded } = nextReview(card, g, NOW, seed, DEFAULT_CONFIG);
      const minutes = (graded.due!.getTime() - NOW.getTime()) / MIN;
      expect(preview[key]).toBe(formatInterval(minutes));
    }
  });

  it("spreads results by seed but stays inside the ±5% band for a ≥20d interval", () => {
    // Good on a 100d/2.5 card → base 250d → ≥20d band → ±5% → [238, 263].
    const card = reviewCard({ intervalDays: 100, ease: 2.5, reps: 5, streak: 5 });
    const seen = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const r = nextReview(card, 3, NOW, `seed-${i}`, DEFAULT_CONFIG);
      seen.add(r.card.intervalDays);
      expect(r.card.intervalDays).toBeGreaterThanOrEqual(Math.round(250 * 0.95));
      expect(r.card.intervalDays).toBeLessThanOrEqual(Math.round(250 * 1.05));
    }
    expect(seen.size).toBeGreaterThan(1); // fuzz genuinely varies with the seed
  });

  it("leaves the interval untouched with fuzz off, regardless of seed", () => {
    const card = reviewCard({ intervalDays: 100, ease: 2.5, reps: 5, streak: 5 });
    expect(nextReview(card, 3, NOW, "x", NO_FUZZ).card.intervalDays).toBe(250);
    expect(nextReview(card, 3, NOW, "y", NO_FUZZ).card.intervalDays).toBe(250);
  });

  it("does not fuzz sub-3-day intervals (graduating 1d is exact)", () => {
    // 1d graduating interval is < 3d → never fuzzed even with fuzz on.
    let card = nextReview(newCard(), 3, NOW, "s", DEFAULT_CONFIG).card; // → learning, 10m
    const r = nextReview(card, 3, NOW, "s", DEFAULT_CONFIG); // → graduate 1d
    expect(r.card.intervalDays).toBe(1);
  });
});

describe("auto-graduation to Known", () => {
  const ON: IntervalConfig = { ...NO_FUZZ, autoGraduateKnown: true };

  it("flips on a successful review at ≥365d AND streak ≥3", () => {
    const card = reviewCard({ intervalDays: 200, ease: 2.5, reps: 5, streak: 2 });
    const r = nextReview(card, 3, NOW, "s", ON); // Good → 500d, streak → 3
    expect(r.card.intervalDays).toBe(500);
    expect(r.card.streak).toBe(3);
    expect(r.graduateToKnown).toBe(true);
  });

  it("does not flip when the streak is still below the bar", () => {
    const card = reviewCard({ intervalDays: 200, ease: 2.5, reps: 5, streak: 1 });
    const r = nextReview(card, 3, NOW, "s", ON); // 500d but streak only reaches 2
    expect(r.card.intervalDays).toBeGreaterThanOrEqual(365);
    expect(r.card.streak).toBe(2);
    expect(r.graduateToKnown).toBe(false);
  });

  it("does not flip when the interval is below 365d", () => {
    const card = reviewCard({ intervalDays: 100, ease: 2.5, reps: 5, streak: 5 });
    const r = nextReview(card, 3, NOW, "s", ON); // 250d < 365
    expect(r.card.intervalDays).toBeLessThan(365);
    expect(r.graduateToKnown).toBe(false);
  });

  it("never flips while the feature is off (default config)", () => {
    const card = reviewCard({ intervalDays: 200, ease: 2.5, reps: 5, streak: 5 });
    const r = nextReview(card, 3, NOW, "s", NO_FUZZ); // qualifying interval+streak, flag off
    expect(r.card.intervalDays).toBeGreaterThanOrEqual(365);
    expect(r.graduateToKnown).toBe(false);
  });

  it("never flips on a Hard answer even at a large interval", () => {
    const card = reviewCard({ intervalDays: 2000, ease: 2.5, reps: 5, streak: 5 });
    const r = nextReview(card, 2, NOW, "s", ON); // Hard → shortens, streak → 0
    expect(r.graduateToKnown).toBe(false);
  });
});

describe("formatInterval", () => {
  it("formats minutes, days, months and years", () => {
    expect(formatInterval(1)).toBe("1m");
    expect(formatInterval(10)).toBe("10m");
    expect(formatInterval(1440)).toBe("1d");
    expect(formatInterval(3 * 1440)).toBe("3d");
    expect(formatInterval(60 * 1440)).toBe("2mo");
    expect(formatInterval(365 * 1440)).toBe("1y");
  });
});

describe("previewIntervals", () => {
  it("labels the four buttons for a fresh card", () => {
    // Again/Hard reshow at step 0 (1m), Good advances to step 1 (10m), Easy graduates (4d).
    expect(previewIntervals(newCard(), NOW, "seed", NO_FUZZ)).toEqual({
      again: "1m",
      hard: "1m",
      good: "10m",
      easy: "4d",
    });
  });
});
