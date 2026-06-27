import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format, startOfDay, subDays } from "date-fns";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getVocabTimeseries, type Granularity } from "../lib/api";
import {
  formatPeriodLabel,
  RANGE_PRESETS,
  toChartRows,
} from "../lib/vocabStats";
import { DateRangePicker } from "./DateRangePicker";

const LANG = "en";
const LEARNING_COLOR = "#2563eb"; // blue (matches the Learning badge)
const KNOWN_COLOR = "#16a34a"; // green (matches the Known badge)
const LEARNED_COLOR = "#7c3aed"; // violet — words that moved learning → known (Learning page)

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

/**
 * The "Stats" view of the vocabulary page: vocabulary growth over a selectable date range,
 * grouped by day / week / month. Two charts — cumulative totals (Learning + Known) and
 * words added per period.
 */
export function VocabularyStats() {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [from, setFrom] = useState<Date>(() => subDays(today, 89));
  const [to, setTo] = useState<Date>(today);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const totalToggle = useSeriesToggle();
  const addedToggle = useSeriesToggle();

  const tsQ = useQuery({
    queryKey: ["vocab-timeseries", { from: ymd(from), to: ymd(to), granularity }],
    queryFn: () =>
      getVocabTimeseries({ from: ymd(from), to: ymd(to), granularity, language: LANG }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    if (!tsQ.data) return [];
    return toChartRows(tsQ.data).map((r) => ({
      ...r,
      label: formatPeriodLabel(r.period, granularity),
    }));
  }, [tsQ.data, granularity]);

  const setPreset = (days: number) => {
    setTo(today);
    setFrom(subDays(today, days - 1));
  };

  return (
    <div className="stats-view">
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
        <p className="muted empty">No vocabulary activity in this range.</p>
      ) : (
        <div className="charts">
          <div className="card chart-card">
            <h3>Total over time</h3>
            <p className="muted small">Cumulative words you've accumulated, by status.</p>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={20} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
                <Tooltip />
                <Legend
                  onClick={totalToggle.onClick}
                  formatter={totalToggle.formatter}
                  wrapperStyle={{ cursor: "pointer" }}
                />
                <Line
                  type="monotone"
                  dataKey="knownTotal"
                  name="Known"
                  stroke={KNOWN_COLOR}
                  strokeWidth={2}
                  dot={false}
                  hide={totalToggle.hidden.has("knownTotal")}
                />
                <Line
                  type="monotone"
                  dataKey="learningTotal"
                  name="Learning"
                  stroke={LEARNING_COLOR}
                  strokeWidth={2}
                  dot={false}
                  hide={totalToggle.hidden.has("learningTotal")}
                />
                <Line
                  type="monotone"
                  dataKey="learnedTotal"
                  name="Learned"
                  stroke={LEARNED_COLOR}
                  strokeWidth={2}
                  dot={false}
                  hide={totalToggle.hidden.has("learnedTotal")}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="card chart-card">
            <h3>Added per {granularity}</h3>
            <p className="muted small">New words you added in each period.</p>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={20} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
                <Tooltip />
                <Legend
                  onClick={addedToggle.onClick}
                  formatter={addedToggle.formatter}
                  wrapperStyle={{ cursor: "pointer" }}
                />
                <Bar
                  dataKey="knownAdded"
                  name="Known"
                  fill={KNOWN_COLOR}
                  radius={[3, 3, 0, 0]}
                  hide={addedToggle.hidden.has("knownAdded")}
                />
                <Bar
                  dataKey="learningAdded"
                  name="Learning"
                  fill={LEARNING_COLOR}
                  radius={[3, 3, 0, 0]}
                  hide={addedToggle.hidden.has("learningAdded")}
                />
                <Bar
                  dataKey="learnedAdded"
                  name="Learned"
                  fill={LEARNED_COLOR}
                  radius={[3, 3, 0, 0]}
                  hide={addedToggle.hidden.has("learnedAdded")}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
