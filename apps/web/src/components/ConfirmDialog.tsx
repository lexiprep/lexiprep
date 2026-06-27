import { ModalOverlay } from "./ModalOverlay";

/** Small confirmation modal for high-stakes actions (e.g. "Finish book"). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalOverlay onClose={onCancel} className="confirm">
      <h3>{title}</h3>
      {message && <p className="muted">{message}</p>}
      <div className="confirm-actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          className={`btn ${danger ? "danger" : "primary"}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalOverlay>
  );
}
