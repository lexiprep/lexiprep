import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format, startOfDay, subDays } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getReviewStats,
  getReviewTimeseries,
  type Granularity,
} from "../lib/api";
import { formatPeriodLabel, RANGE_PRESETS } from "../lib/vocabStats";
import { DateRangePicker } from "./DateRangePicker";

// Grade colours (match the modal grade badges): Again red, Hard amber, Good green, Easy blue.
const AGAIN_COLOR = "var(--red)";
const HARD_COLOR = "var(--amber)";
const GOOD_COLOR = "var(--green)";
const EASY_COLOR = "var(--blue)";

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const ymd = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * Classic legend toggling: clicking a legend entry hides/shows that series. Returns the
 * hidden set plus the legend `onClick` + `formatter` (which greys out hidden entries).
 */
function useSeriesToggle() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const keyOf = (dataKey: unknown) =>
    typeof dataKey === "string" || typeof dataKey === "number" ? String(dataKey) : "";
  const onClick = (entry: { dataKey?: unknown }) => {
    const key = keyOf(entry?.dataKey);
    if (!key) return;
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const formatter = (value: unknown, entry: { dataKey?: unknown }) => {
    const off = hidden.has(keyOf(entry?.dataKey));
    return <span style={{ opacity: off ? 0.4 : 1 }}>{String(value)}</span>;
  };
  return { hidden, onClick, formatter };
}

/** One headline stat tile: a big value over a muted label. */
function StatTile({
  value,
  label,
  emphasis,
}: {
  value: string;
  label: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="card"
      style={{
        flex: "1 1 130px",
        textAlign: "center",
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontSize: emphasis ? 34 : 26,
          fontWeight: 700,
          lineHeight: 1.1,
          color: emphasis ? "var(--accent)" : undefined,
        }}
      >
        {value}
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {label}
      </div>
    </div>
  );
}

/**
 * The review (spaced-repetition) section of the Stats page: headline SRS tiles
 * (day streak, reviewed today/all-time, average days between reviews) and a
 * reviews-per-period chart with grade breakdown, over a selectable date range.
 * Mirrors {@link VocabularyStats}' range + granularity controls and chart conventions.
 */
export function ReviewStats() {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [from, setFrom] = useState<Date>(() => subDays(today, 89));
  const [to, setTo] = useState<Date>(today);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const gradeToggle = useSeriesToggle();

  const statsQ = useQuery({
    queryKey: ["review-stats"],
    queryFn: getReviewStats,
  });

  const tsQ = useQuery({
    queryKey: ["review-timeseries", { from: ymd(from), to: ymd(to), granularity }],
    queryFn: () => getReviewTimeseries({ from: ymd(from), to: ymd(to), granularity }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    if (!tsQ.data) return [];
    return tsQ.data.buckets.map((b) => ({
      ...b,
      label: formatPeriodLabel(b.period, granularity),
    }));
  }, [tsQ.data, granularity]);

  const setPreset = (days: number) => {
    setTo(today);
    setFrom(subDays(today, days - 1));
  };

  const s = statsQ.data;
  const avg = s?.avgDaysBetween;

  return (
    <div className="stats-view">
      <div
        className="review-tiles"
        style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}
      >
        <StatTile value={`🔥 ${s?.dayStreak ?? 0}`} label="day streak" emphasis />
        <StatTile value={String(s?.reviewedToday ?? 0)} label="reviewed today" />
        <StatTile value={String(s?.reviewedAllTime ?? 0)} label="reviewed all-time" />
        <StatTile
          value={avg == null ? "—" : avg.toFixed(1)}
          label="avg days between"
        />
      </div>

      <div className="toolbar stats-toolbar">
        <DateRangePicker
          from={from}
          to={to}
          onChange={({ from: f, to: t }) => {
            setFrom(startOfDay(f));
            setTo(startOfDay(t));
          }}
        />

        <div className="preset-group">
          {RANGE_PRESETS.map((p) => (
            <button key={p.label} className="btn ghost slim" onClick={() => setPreset(p.days)}>
              {p.label}
            </button>
          ))}
        </div>

        <span className="grow" />

        <div className="seg-group" role="group" aria-label="Group by">
          {GRANULARITIES.map((g) => (
            <button
              key={g.value}
              className={`seg${granularity === g.value ? " active" : ""}`}
              aria-pressed={granularity === g.value}
              onClick={() => setGranularity(g.value)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {tsQ.isLoading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted empty">No reviews in this range.</p>
      ) : (
        <div className="charts">
          <div className="card chart-card">
            <h3>Reviews per {granularity}</h3>
            <p className="muted small">Cards reviewed in each period, by grade.</p>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={20} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
                <Tooltip />
                <Legend
                  onClick={gradeToggle.onClick}
                  formatter={gradeToggle.formatter}
                  wrapperStyle={{ cursor: "pointer" }}
                />
                <Bar
                  dataKey="again"
                  name="Again"
                  stackId="grade"
                  fill={AGAIN_COLOR}
                  hide={gradeToggle.hidden.has("again")}
                />
                <Bar
                  dataKey="hard"
                  name="Hard"
                  stackId="grade"
                  fill={HARD_COLOR}
                  hide={gradeToggle.hidden.has("hard")}
                />
                <Bar
                  dataKey="good"
                  name="Good"
                  stackId="grade"
                  fill={GOOD_COLOR}
                  hide={gradeToggle.hidden.has("good")}
                />
                <Bar
                  dataKey="easy"
                  name="Easy"
                  stackId="grade"
                  fill={EASY_COLOR}
                  radius={[3, 3, 0, 0]}
                  hide={gradeToggle.hidden.has("easy")}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
