// Spaced-repetition interval math — the feature's critical, owned business logic
// (spec: docs/specs/12-card-review-srs.md §"Interval math").
//
// This module is PURE: no DB, no IO, no `Date.now()`, no `Math.random()`. The clock
// (`now`) and the fuzz `seed` are passed in by the caller (the grade route). That keeps
// it directly unit-testable and lets the whole algorithm be swapped (e.g. for ts-fsrs)
// behind these signatures without touching anything else.
//
// SM-2-derived, with two deliberate divergences from classic Anki encoded as constants:
//   - HARD_FACTOR = 0.25 (< 1) → review-Hard SHORTENS the interval ("Hard demotes").
//   - LAPSE_FACTOR = 0.0      → a lapse fully resets (post-relearn interval floors to 1 d).

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export type SrsState = "new" | "learning" | "review" | "relearning";

/** Per-card SRS state. Mirrors the `srs_*` columns on `user_words` (spec §Per-card state). */
export interface CardState {
  state: SrsState;
  intervalDays: number; // last scheduled review-phase interval (0 while in sub-day steps)
  ease: number; // the ease multiplier
  reps: number; // successful review-phase answers
  lapses: number; // times the card fell back to relearning
  step: number; // index into the learning/relearning step ladder
  streak: number; // consecutive Good/Easy (drives auto-Known)
  due: Date | null; // next due time
  lastReviewed: Date | null; // last review time
  preLapseInterval: number; // interval right before the last lapse
}

/** All tunable constants in one object (spec §Constants). */
export interface IntervalConfig {
  learningSteps: number[]; // minutes
  relearningSteps: number[]; // minutes
  graduatingInterval: number; // days
  easyInterval: number; // days
  startingEase: number;
  easeMin: number;
  easeMax: number;
  againEaseDelta: number;
  hardEaseDelta: number;
  easyEaseDelta: number;
  easyBonus: number;
  intervalModifier: number;
  hardFactor: number; // review-Hard multiplier (0.25 → shortens)
  lapseFactor: number; // post-relearn interval = preLapseInterval × this
  minInterval: number; // days
  maxInterval: number; // days
  fuzz: boolean;
  autoGraduateKnown: boolean;
  knownIntervalDays: number;
  knownStreak: number;
}

export const DEFAULT_CONFIG: IntervalConfig = {
  learningSteps: [1, 10],
  relearningSteps: [10],
  graduatingInterval: 1,
  easyInterval: 4,
  startingEase: 2.5,
  easeMin: 1.3,
  easeMax: 3.0,
  againEaseDelta: -0.2,
  hardEaseDelta: -0.15,
  easyEaseDelta: 0.15,
  easyBonus: 1.3,
  intervalModifier: 1.0,
  hardFactor: 0.25,
  lapseFactor: 0.0,
  minInterval: 1,
  maxInterval: 36500,
  fuzz: true,
  autoGraduateKnown: false,
  knownIntervalDays: 365,
  knownStreak: 3,
};

/** A single append-only review-log row (everything an FSRS optimizer later consumes). */
export interface ReviewLogEntry {
  rating: Rating;
  stateBefore: SrsState;
  elapsedDays: number; // days since the previous review (0 if first)
  scheduledDays: number; // the interval that had been due before this grade
  intervalAfter: number; // new intervalDays (0 for sub-day learning/relearning steps; see below)
  easeAfter: number;
}

export interface NextReviewResult {
  card: CardState;
  graduateToKnown: boolean;
  log: ReviewLogEntry;
}

/** Human button labels for the four grades, e.g. { again: "1m", good: "20d", easy: "1mo" }. */
export interface IntervalPreview {
  again: string;
  hard: string;
  good: string;
  easy: string;
}

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** A fresh card, never reviewed (spec §Per-card state "init" column). */
export function newCard(): CardState {
  return {
    state: "new",
    intervalDays: 0,
    ease: DEFAULT_CONFIG.startingEase,
    reps: 0,
    lapses: 0,
    step: 0,
    streak: 0,
    due: null,
    lastReviewed: null,
    preLapseInterval: 0,
  };
}

// --- deterministic seeded RNG (no Math.random) -----------------------------------------
// FNV-1a 32-bit string hash → mulberry32. Tiny, dependency-free, fully deterministic.
// Both previewIntervals() and nextReview() receive the SAME seed string and SAME card, so
// they draw the identical fuzz fraction → the button label equals what the grade schedules.

function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampDays(days: number, cfg: IntervalConfig): number {
  return Math.min(cfg.maxInterval, Math.max(cfg.minInterval, days));
}

/**
 * Fuzz a review-phase day interval so a forever-list doesn't pile every graduate onto the
 * same future day (spec §Transitions): none `<3 d`, ±15% `3–7 d`, ±10% `7–20 d`, ±5% `≥20 d`.
 * Deterministic in `seed`; a no-op when fuzz is off or the interval is sub-3-day.
 */
function fuzzDays(intervalDays: number, seed: string, cfg: IntervalConfig): number {
  if (!cfg.fuzz || intervalDays < 3) return intervalDays;
  const pct = intervalDays < 7 ? 0.15 : intervalDays < 20 ? 0.1 : 0.05;
  const r = mulberry32(hashSeed(seed))(); // single draw in [0, 1)
  const factor = 1 + (r * 2 - 1) * pct; // → [1 - pct, 1 + pct]
  return clampDays(Math.round(intervalDays * factor), cfg);
}

function addMinutes(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * MIN_MS);
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

function stepAt(steps: number[], idx: number): number {
  return steps[idx] ?? 0;
}

/**
 * Grade a card and compute its next state + due date (spec §Transitions). Pure: returns a
 * fresh card; never mutates the input.
 *
 * Rounding: every review-phase interval is `clamp(round(formula))` with `Math.round`
 * (half-up — matches the spec's worked `round(30 × 0.25) = 8`). Because the Good ladder
 * compounds the ROUNDED interval each step (`1 → 3 → 8 → 20 → …` per the spec's worked
 * path "1×2.5≈3 → 3×2.5≈8 → 8×2.5=20"), the integer ladder runs slightly above the
 * idealised continuous `≈ 2.5^reps` the spec also cites — the worked path is authoritative.
 *
 * Log note: `intervalAfter` reflects `card.intervalDays`, which is 0 during the sub-day
 * learning/relearning steps (the chosen convention — sub-day reshows log `intervalAfter = 0`).
 */
export function nextReview(
  card: CardState,
  grade: Rating,
  now: Date,
  seed: string,
  cfg: IntervalConfig = DEFAULT_CONFIG,
): NextReviewResult {
  const stateBefore = card.state;
  const elapsedDays = card.lastReviewed
    ? (now.getTime() - card.lastReviewed.getTime()) / DAY_MS
    : 0;
  const scheduledDays = stateBefore === "review" ? card.intervalDays : 0;

  const next: CardState = { ...card, lastReviewed: now };
  let graduateToKnown = false;

  if (stateBefore === "review") {
    const I = card.intervalDays;
    const e = card.ease;
    if (grade === 1) {
      // Again → lapse into relearning.
      next.ease = Math.max(cfg.easeMin, e + cfg.againEaseDelta);
      next.lapses = card.lapses + 1;
      next.preLapseInterval = I;
      next.state = "relearning";
      next.step = 0;
      next.intervalDays = 0;
      next.streak = 0;
      next.due = addMinutes(now, stepAt(cfg.relearningSteps, 0));
    } else if (grade === 2) {
      // Hard → SHORTENS (HARD_FACTOR < 1).
      next.ease = Math.max(cfg.easeMin, e + cfg.hardEaseDelta);
      next.intervalDays = fuzzDays(clampDays(Math.round(I * cfg.hardFactor), cfg), seed, cfg);
      next.reps = card.reps + 1;
      next.streak = 0;
      next.due = addDays(now, next.intervalDays);
    } else if (grade === 3) {
      // Good → × ease.
      next.intervalDays = fuzzDays(
        clampDays(Math.round(I * e * cfg.intervalModifier), cfg),
        seed,
        cfg,
      );
      next.reps = card.reps + 1;
      next.streak = card.streak + 1;
      next.due = addDays(now, next.intervalDays);
    } else {
      // Easy → × ease × bonus, and bump ease.
      next.ease = Math.min(cfg.easeMax, e + cfg.easyEaseDelta);
      next.intervalDays = fuzzDays(
        clampDays(Math.round(I * e * cfg.easyBonus * cfg.intervalModifier), cfg),
        seed,
        cfg,
      );
      next.reps = card.reps + 1;
      next.streak = card.streak + 1;
      next.due = addDays(now, next.intervalDays);
    }
    // Auto-graduate to Known after a successful (Good/Easy) review (spec §Auto-graduation).
    if (
      cfg.autoGraduateKnown &&
      (grade === 3 || grade === 4) &&
      next.intervalDays >= cfg.knownIntervalDays &&
      next.streak >= cfg.knownStreak
    ) {
      graduateToKnown = true;
    }
  } else {
    // Learning / relearning step ladder (state new | learning | relearning).
    const isRelearning = stateBefore === "relearning";
    const steps = isRelearning ? cfg.relearningSteps : cfg.learningSteps;
    const phaseState: SrsState = isRelearning ? "relearning" : "learning";
    if (grade === 1) {
      // Again → back to the first step.
      next.state = phaseState;
      next.step = 0;
      next.streak = 0;
      next.due = addMinutes(now, stepAt(steps, 0));
    } else if (grade === 2) {
      // Hard → repeat the current step.
      const idx = Math.min(card.step, steps.length - 1);
      next.state = phaseState;
      next.step = idx;
      next.due = addMinutes(now, stepAt(steps, idx));
    } else if (grade === 3) {
      const nextStep = card.step + 1;
      if (nextStep < steps.length) {
        // Good → advance to the next sub-day step.
        next.state = phaseState;
        next.step = nextStep;
        next.due = addMinutes(now, stepAt(steps, nextStep));
      } else {
        // Good on the last step → graduate to review.
        const base = isRelearning
          ? Math.round(card.preLapseInterval * cfg.lapseFactor)
          : cfg.graduatingInterval;
        next.state = "review";
        next.step = 0;
        next.intervalDays = fuzzDays(clampDays(base, cfg), seed, cfg);
        next.reps = card.reps + 1;
        next.streak = card.streak + 1;
        next.due = addDays(now, next.intervalDays);
      }
    } else {
      // Easy → graduate immediately at EASY_INTERVAL.
      next.state = "review";
      next.step = 0;
      next.intervalDays = fuzzDays(clampDays(cfg.easyInterval, cfg), seed, cfg);
      next.reps = card.reps + 1;
      next.streak = card.streak + 1;
      next.due = addDays(now, next.intervalDays);
    }
  }

  const log: ReviewLogEntry = {
    rating: grade,
    stateBefore,
    elapsedDays,
    scheduledDays,
    intervalAfter: next.intervalDays,
    easeAfter: next.ease,
  };

  return { card: next, graduateToKnown, log };
}

/** Format an interval given in MINUTES as a short human label ("1m", "10m", "1d", "3d", "2mo", "1y"). */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`; // defensive — real intervals are sub-hour or ≥1 day
  const days = minutes / 1440;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

/**
 * Dry-run all four grades against the same `now`/`seed` and return their next-due labels for
 * the grade buttons. Because it calls `nextReview` with the identical seed the real grade
 * will use, every label equals what pressing that button actually schedules.
 */
export function previewIntervals(
  card: CardState,
  now: Date,
  seed: string,
  cfg: IntervalConfig = DEFAULT_CONFIG,
): IntervalPreview {
  const label = (grade: Rating): string => {
    const { card: graded } = nextReview(card, grade, now, seed, cfg);
    const minutes = (graded.due!.getTime() - now.getTime()) / MIN_MS;
    return formatInterval(minutes);
  };
  return { again: label(1), hard: label(2), good: label(3), easy: label(4) };
}
