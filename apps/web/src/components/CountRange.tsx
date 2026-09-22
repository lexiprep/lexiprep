import { useEffect, useRef, useState } from "react";

/** Label for the trigger button: the bounds in words, or "Any" when both are open. */
function summary(min: string, max: string): string {
  if (min && max) return `${min}–${max}`;
  if (min) return `${min}+`;
  if (max) return `≤ ${max}`;
  return "Any";
}

/**
 * A min–max filter on how often a word occurs across **all** the user's books, as two
 * number inputs in a dropdown (the toolbar has no room for them side by side). Bounds are
 * inclusive and each is optional; edits apply on a short debounce, like the search box.
 * Used by the vocabulary page — `minCount: 10` is the "is this worth learning?" cut.
 */
export function CountRange({
  min,
  max,
  onChange,
}: {
  min: string;
  max: string;
  onChange: (next: { min: string; max: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ min, max });
  // The applied values are the source of truth (they persist); re-sync when they change
  // from outside (e.g. a filter reset) so the inputs never show a stale draft.
  useEffect(() => {
    setDraft({ min, max });
  }, [min, max]);

  // Debounce so typing "120" doesn't fire a request at "1" and "12".
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (draft.min === min && draft.max === max) return;
    const t = setTimeout(() => onChangeRef.current(draft), 400);
    return () => clearTimeout(t);
  }, [draft, min, max]);

  // Digits only — an empty string means "no bound".
  const set = (key: "min" | "max") => (value: string) => {
    if (!/^\d*$/.test(value)) return;
    setDraft((d) => ({ ...d, [key]: value }));
  };

  return (
    <span className="ctl count-range">
      <span className="ctl-name">Count</span>
      <button
        type="button"
        className="btn ghost slim count-range-btn"
        aria-expanded={open}
        aria-haspopup="true"
        title="Filter by how often the word occurs across all your books"
        onClick={() => setOpen((o) => !o)}
      >
        {summary(min, max)}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div
            className="count-range-pop card"
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          >
            <p className="muted small">Occurrences across all your books</p>
            <div className="count-range-inputs">
              <label className="ctl">
                Min
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="any"
                  value={draft.min}
                  aria-label="Minimum count"
                  autoFocus
                  onChange={(e) => set("min")(e.target.value)}
                />
              </label>
              <span className="range-dash">–</span>
              <label className="ctl">
                Max
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="any"
                  value={draft.max}
                  aria-label="Maximum count"
                  onChange={(e) => set("max")(e.target.value)}
                />
              </label>
            </div>
            <div className="count-range-foot">
              <button
                type="button"
                className="btn ghost slim"
                disabled={!draft.min && !draft.max}
                onClick={() => setDraft({ min: "", max: "" })}
              >
                Clear
              </button>
              <button type="button" className="btn slim" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  );
}
