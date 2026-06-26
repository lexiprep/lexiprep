import { CEFR_LEVELS } from "../lib/levels";

// The unleveled band — words with no CEFR level (names / very rare words). Sorts below A1
// on the server (the `none` sentinel), so it sits first in each select.
const UNLEVELED = { value: "none", label: "—" };

/**
 * A CEFR from–to range filter (two selects). Each bound is optional ("Any"); the server
 * treats `from` as a floor and `to` as a ceiling, both inclusive. The leading "—" option
 * targets unleveled words (names / rare). Used on the book review table and the cross-book
 * learning list.
 */
export function LevelRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
}) {
  return (
    <span className="ctl level-range">
      Level
      <select
        value={from}
        aria-label="Level from"
        title="Lowest level to include (— = unleveled: names / rare words)"
        onChange={(e) => onChange({ from: e.target.value, to })}
      >
        <option value="">Any</option>
        <option value={UNLEVELED.value}>{UNLEVELED.label}</option>
        {CEFR_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <span className="range-dash">–</span>
      <select
        value={to}
        aria-label="Level to"
        title="Highest level to include (— = unleveled: names / rare words)"
        onChange={(e) => onChange({ from, to: e.target.value })}
      >
        <option value="">Any</option>
        <option value={UNLEVELED.value}>{UNLEVELED.label}</option>
        {CEFR_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    </span>
  );
}
