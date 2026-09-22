import { useEffect, useState, type ReactNode } from "react";
import { ModalOverlay } from "./ModalOverlay";

const MOBILE = "(max-width: 640px)";

function mobileNow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE).matches
  );
}

/** True at the same width where the word list drops its inline toolbar. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(mobileNow);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MOBILE);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

/**
 * Word-list filters. Desktop renders them inline. On a phone they move into a modal
 * opened by a Filters button, and every value that isn't the default stays visible
 * under that button — otherwise a narrowed list looks like the full one.
 * `applied` is those phrases, already worded for a person ("Level A2–B1", "50× or more").
 */
export function FilterSheet({
  applied,
  children,
}: {
  applied: string[];
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!mobile) return <div className="toolbar">{children}</div>;

  return (
    <div className="filter-bar">
      <button
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Filters
      </button>
      {applied.length > 0 && <p className="filter-applied">{applied.join(" · ")}</p>}
      {open && (
        <ModalOverlay onClose={() => setOpen(false)} className="filter-modal">
          <div className="modal-body">
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <h3>Filters</h3>
            <div className="toolbar">{children}</div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn primary" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </ModalOverlay>
      )}
    </div>
  );
}
