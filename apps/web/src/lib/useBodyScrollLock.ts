import { useEffect } from "react";

// Module-level ref count so several stacked modals share one lock: the page only unlocks
// once the *last* modal closes. We capture the body's prior inline styles when the count
// goes 0 → 1 and restore them when it returns to 0.
let lockCount = 0;
let prevOverflow = "";
let prevPaddingRight = "";

/**
 * Lock `<body>` scroll for as long as the calling component is mounted, so the page behind
 * an open modal can't scroll. Ref-counted (safe for stacked modals and React StrictMode's
 * double-invoke) and scrollbar-width-compensating (pads the body by the width of the
 * scrollbar that `overflow: hidden` removes, so the page doesn't shift sideways).
 */
export function useBodyScrollLock(): void {
  useEffect(() => {
    if (lockCount === 0) {
      const { body, documentElement } = document;
      prevOverflow = body.style.overflow;
      prevPaddingRight = body.style.paddingRight;
      const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
      if (scrollbarWidth > 0) {
        const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
        body.style.paddingRight = `${current + scrollbarWidth}px`;
      }
      body.style.overflow = "hidden";
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        document.body.style.overflow = prevOverflow;
        document.body.style.paddingRight = prevPaddingRight;
      }
    };
  }, []);
}
