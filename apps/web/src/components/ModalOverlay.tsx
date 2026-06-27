import { type ReactNode } from "react";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";

/**
 * The shared shell for every modal: a full-screen backdrop that closes on click, an inner
 * `.modal` panel that stops click propagation, and a body scroll lock that holds while the
 * modal is mounted. EVERY modal in the app must render through this so the background can
 * never scroll behind an open modal — do not hand-roll a `.modal-overlay` elsewhere.
 */
export function ModalOverlay({
  onClose,
  className,
  children,
}: {
  /** Invoked when the backdrop is clicked. */
  onClose: () => void;
  /** Extra classes for the inner `.modal` panel (e.g. "confirm", "export-modal"). */
  className?: string;
  children: ReactNode;
}) {
  useBodyScrollLock();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal${className ? ` ${className}` : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
