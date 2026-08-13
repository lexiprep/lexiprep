import { describe, it, expect } from "vitest";
import {
  AXIS_LOCK,
  MAX_TILT,
  SWIPE_RATIO,
  SWIPE_VELOCITY,
  swipeDecision,
  swipeProgress,
  swipeTilt,
  swipeVelocity,
} from "../src/lib/swipe";

const W = 300; // card width; the commit threshold is SWIPE_RATIO of it (75px)

describe("swipeDecision", () => {
  it("springs back when the drag stays short and slow", () => {
    expect(swipeDecision(40, W, 0.05)).toBeNull();
    expect(swipeDecision(-40, W, -0.05)).toBeNull();
  });

  it("commits right past the distance threshold", () => {
    expect(swipeDecision(W * SWIPE_RATIO, W, 0)).toBe("right");
    expect(swipeDecision(W * 0.6, W, 0)).toBe("right");
  });

  it("commits left past the distance threshold", () => {
    expect(swipeDecision(-W * SWIPE_RATIO, W, 0)).toBe("left");
  });

  it("commits a fast flick that never travelled far", () => {
    expect(swipeDecision(30, W, SWIPE_VELOCITY)).toBe("right");
    expect(swipeDecision(-30, W, -SWIPE_VELOCITY)).toBe("left");
  });

  // A flick whose velocity points the other way is the tail of a direction change, not a
  // commit — otherwise dragging left then snapping back would mark the word known.
  it("ignores a flick travelling opposite to the drag", () => {
    expect(swipeDecision(30, W, -SWIPE_VELOCITY)).toBeNull();
  });

  it("never commits below the axis-lock distance, however fast", () => {
    expect(swipeDecision(AXIS_LOCK - 1, W, 10)).toBeNull();
  });

  it("is inert without a measured width", () => {
    expect(swipeDecision(200, 0, 1)).toBeNull();
  });
});

describe("swipeProgress", () => {
  it("ramps 0→1 across the commit threshold and clamps beyond it", () => {
    expect(swipeProgress(0, W)).toBe(0);
    expect(swipeProgress(W * SWIPE_RATIO * 0.5, W)).toBeCloseTo(0.5);
    expect(swipeProgress(W * SWIPE_RATIO, W)).toBe(1);
    expect(swipeProgress(W, W)).toBe(1);
  });

  it("is direction-agnostic (the caller picks which stamp to show)", () => {
    expect(swipeProgress(-W * SWIPE_RATIO, W)).toBe(1);
  });

  it("is 0 without a measured width", () => {
    expect(swipeProgress(50, 0)).toBe(0);
  });
});

describe("swipeTilt", () => {
  it("caps at MAX_TILT in both directions", () => {
    expect(swipeTilt(W * 2, W)).toBe(MAX_TILT);
    expect(swipeTilt(-W * 2, W)).toBe(-MAX_TILT);
    expect(swipeTilt(W / 2, W)).toBeCloseTo(MAX_TILT / 2);
  });
});

describe("swipeVelocity", () => {
  it("is signed px/ms", () => {
    expect(swipeVelocity(100, 200)).toBe(0.5);
    expect(swipeVelocity(-100, 200)).toBe(-0.5);
  });

  it("survives a zero or backwards clock", () => {
    expect(swipeVelocity(100, 0)).toBe(0);
    expect(swipeVelocity(100, -5)).toBe(0);
  });
});
