/**
 * Swipe gesture maths for the card deck (see components/CardMode.tsx).
 *
 * Kept free of DOM types on purpose: the component owns the pointer plumbing, this owns
 * the thresholds and the numbers that drive the transform. That split is what makes the
 * gesture testable — jsdom can't produce a believable touch drag, but it can check that a
 * 30%-of-width pull commits and a 10%-of-width one springs back.
 */

/** Commit once the card is dragged past this fraction of its own width. */
export const SWIPE_RATIO = 0.25;
/** …or on a flick faster than this (px per ms), even if it didn't travel far. */
export const SWIPE_VELOCITY = 0.5;
/** Movement (px) before we decide whether a drag is a horizontal swipe or a vertical scroll. */
export const AXIS_LOCK = 10;
/** Degrees of tilt at a full-width drag — small; a card that spins reads as a bug. */
export const MAX_TILT = 12;

export type SwipeDir = "left" | "right";

/**
 * Which way (if either) a finished drag commits. `velocity` is signed px/ms over the whole
 * drag. A flick still has to clear `AXIS_LOCK`, so a fast tap-and-jitter can't mark a word.
 */
export function swipeDecision(
  dx: number,
  width: number,
  velocity: number,
): SwipeDir | null {
  if (width <= 0 || Math.abs(dx) < AXIS_LOCK) return null;
  const far = Math.abs(dx) >= width * SWIPE_RATIO;
  const fast = Math.abs(velocity) >= SWIPE_VELOCITY && Math.sign(velocity) === Math.sign(dx);
  if (!far && !fast) return null;
  return dx > 0 ? "right" : "left";
}

/** How committed the drag looks, 0→1, driving the opacity of the KNOWN/LEARNING stamp. */
export function swipeProgress(dx: number, width: number): number {
  if (width <= 0) return 0;
  return Math.min(1, Math.abs(dx) / (width * SWIPE_RATIO));
}

/** Tilt in degrees, proportional to the drag and capped at `MAX_TILT`. */
export function swipeTilt(dx: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(-1, Math.min(1, dx / width)) * MAX_TILT;
}

/** Signed px/ms. Guards a zero (or backwards) clock, which some browsers do emit. */
export function swipeVelocity(dx: number, elapsedMs: number): number {
  return elapsedMs > 0 ? dx / elapsedMs : 0;
}
