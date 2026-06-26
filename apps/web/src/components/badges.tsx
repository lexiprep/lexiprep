import { LEVEL_COLOR } from "../lib/levels";
import type { UserWordStatus } from "../lib/api";

export function LevelBadge({ level }: { level: string | null }) {
  if (!level) return <span className="muted">—</span>;
  return (
    <span className="level-badge" style={{ background: LEVEL_COLOR[level] ?? "#777" }}>
      {level}
    </span>
  );
}

const STATUS_CLASS: Record<UserWordStatus, string> = {
  learning: "blue",
  known: "green",
  ignored: "gray",
};

export function StatusBadge({ status }: { status: UserWordStatus | null }) {
  if (!status) return <span className="muted">new</span>;
  return <span className={`pill ${STATUS_CLASS[status]}`}>{status}</span>;
}
