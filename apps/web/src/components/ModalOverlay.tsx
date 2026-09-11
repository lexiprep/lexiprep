import { type ReactNode } from "react";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";

/**
 * The shared shell for every modal: a full-screen backdrop, an inner `.modal` panel that
 * stops click propagation, and a body scroll lock that holds while the modal is mounted.
 * Backdrop click closes by default; pass `closeOnBackdrop={false}` to require an explicit
 * close control (e.g. the word modal's X). EVERY modal in the app must render through this
 * so the background can never scroll behind an open modal — do not hand-roll a
 * `.modal-overlay` elsewhere.
 */
export function ModalOverlay({
  onClose,
  className,
  closeOnBackdrop = true,
  children,
}: {
  /** Invoked when the backdrop is clicked (if `closeOnBackdrop`) or by the caller's close control. */
  onClose: () => void;
  /** Extra classes for the inner `.modal` panel (e.g. "confirm", "export-modal"). */
  className?: string;
  /** When false, clicking the dimmed backdrop does not close. Default true. */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  useBodyScrollLock();
  return (
    <div className="modal-overlay" onClick={closeOnBackdrop ? onClose : undefined}>
      <div
        className={`modal${className ? ` ${className}` : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
