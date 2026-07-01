import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, callUsageDemo } from "../lib/api";
import { UsageLimitTip, useFeatureUsage, usageLimitMessage } from "./FeatureUsage";

const SLUG = "ai-word-definition-from-context" as const;

/**
 * Dev-only widget that exercises the usage-limit machinery end-to-end (spec 13). It
 * hits the fake protected endpoint (`POST /api/usage/demo`); once the seeded limit
 * (5/min) is hit the guard 429s, the tooltip explains it, and the button disables.
 * Rendered only under `import.meta.env.DEV` — see BooksPage.
 */
export function UsageDemo() {
  const qc = useQueryClient();
  const usage = useFeatureUsage(SLUG);
  const call = useMutation({
    mutationFn: callUsageDemo,
    onSuccess: () => toast.success("Protected call succeeded"),
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.status === 429
          ? err.message
          : err instanceof Error
            ? err.message
            : "Demo call failed",
      ),
    // Refresh remaining usage either way (429 flips it to "limit reached").
    onSettled: () => qc.invalidateQueries({ queryKey: ["usage", SLUG] }),
  });

  const message = usageLimitMessage(usage.data);
  const remaining = usage.data?.windows
    .map((w) => `${w.remaining}/${w.max} per ${w.window}`)
    .join(" · ");

  return (
    <div className="card" style={{ marginTop: "1.5rem" }}>
      <h3>Usage-limit demo (dev only)</h3>
      <p className="muted small">
        Calls a fake protected endpoint (<code>{SLUG}</code>). Click past the limit to see
        the guard reject it and the tooltip appear.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <UsageLimitTip message={message}>
          <button
            className="btn primary"
            onClick={() => call.mutate()}
            disabled={call.isPending || !!message}
          >
            {call.isPending ? "Calling…" : "Call protected endpoint"}
          </button>
        </UsageLimitTip>
        {remaining && <span className="muted small">{remaining}</span>}
      </div>
    </div>
  );
}
