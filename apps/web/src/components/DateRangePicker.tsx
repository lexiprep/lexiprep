import { useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { format } from "date-fns";

/**
 * A compact from–to date range selector: a button showing the current range that opens a
 * two-month calendar popover (react-day-picker, range mode). Calls `onChange` once both
 * ends are picked. Same package clara uses for date ranges.
 */
export function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: Date;
  to: Date;
  onChange: (range: { from: Date; to: Date }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>({ from, to });

  return (
    <div className="date-range">
      <button
        type="button"
        className="btn ghost slim"
        onClick={() => {
          setDraft({ from, to });
          setOpen((o) => !o);
        }}
      >
        {format(from, "MMM d, yyyy")} – {format(to, "MMM d, yyyy")}
      </button>

      {open && (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="date-range-pop card">
            <DayPicker
              mode="range"
              numberOfMonths={2}
              selected={draft}
              defaultMonth={from}
              onSelect={(range) => {
                setDraft(range);
                if (range?.from && range?.to) {
                  onChange({ from: range.from, to: range.to });
                  setOpen(false);
                }
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
