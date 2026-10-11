/** Presets for "when was this word added", newest spans first, then ever-older cut-offs. */
export const ADDED_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "within:7d", label: "Last 7 days" },
  { value: "within:1m", label: "Last month" },
  { value: "older:1m", label: "Over a month ago" },
  { value: "older:3m", label: "Over 3 months ago" },
  { value: "older:6m", label: "Over 6 months ago" },
  { value: "older:12m", label: "Over a year ago" },
] as const;

/**
 * Turn a preset into the `addedAfter` / `addedBefore` bounds the API takes. Cut-offs are
 * calendar-based and snap to the start of the viewer's day, so "over a year ago" means
 * the same thing all day long (and the query key built from it stays stable).
 */
export function addedRange(
  preset: string,
  now: Date = new Date(),
): { addedAfter?: string; addedBefore?: string } {
  const m = /^(within|older):(\d+)([dm])$/.exec(preset);
  if (!m) return {};
  const cut = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (m[3] === "d") cut.setDate(cut.getDate() - Number(m[2]));
  else cut.setMonth(cut.getMonth() - Number(m[2]));
  const iso = cut.toISOString();
  return m[1] === "within" ? { addedAfter: iso } : { addedBefore: iso };
}
