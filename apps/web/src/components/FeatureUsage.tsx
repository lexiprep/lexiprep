import { useId, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "react-tooltip";
import "react-tooltip/dist/react-tooltip.css";
import { checkUsage, type PaidFeatureSlug, type UsageCheck } from "../lib/api";

/**
 * Reusable usage-limit UI for paid features (spec 13). `useFeatureUsage` reads the
 * user's remaining usage for a slug; `UsageLimitTip` wraps a control and, once the
 * limit is hit, disables interaction and explains it in a tooltip. Invalidate the
 * `["usage", slug]` query after a guarded call so the state updates live (a 429 flips
 * it to "limit reached"; a success counts `remaining` down).
 */
export function useFeatureUsage(slug: PaidFeatureSlug) {
  return useQuery({ queryKey: ["usage", slug], queryFn: () => checkUsage(slug) });
}

/** Human message for a hit limit, or null when the user still has usage. */
export function usageLimitMessage(usage: UsageCheck | undefined): string | null {
  if (!usage || usage.allowed) return null;
  const exceeded = usage.windows.filter((w) => w.used >= w.max);
  // The binding reset is the latest among the exceeded windows.
  const latest = exceeded
    .filter((w) => w.resetAt)
    .sort((a, b) => Date.parse(b.resetAt!) - Date.parse(a.resetAt!))[0];
  const window = exceeded[0]?.window;
  const label = window ? window.charAt(0).toUpperCase() + window.slice(1) : "Usage";
  if (!latest?.resetAt) return `${label} limit reached.`;
  return `${label} limit reached — resets at ${new Date(latest.resetAt).toLocaleTimeString()}.`;
}

/**
 * Wrap an action in a tooltip that appears only when its usage limit is hit. When
 * `message` is set the wrapped control is dimmed and non-interactive; otherwise it
 * renders through untouched.
 */
export function UsageLimitTip({
  message,
  children,
}: {
  message: string | null;
  children: ReactNode;
}) {
  const id = useId();
  if (!message) return <>{children}</>;
  return (
    <>
      {/* The anchor stays interactive so the tooltip opens on tap/click; the inner
          wrapper dims the control and swallows its pointer events (clicks fall through
          to the anchor, which is why hit-testing reaches it). */}
      <span data-tooltip-id={id} style={{ display: "inline-block", cursor: "help" }}>
        <span style={{ opacity: 0.5, pointerEvents: "none" }}>{children}</span>
      </span>
      <Tooltip id={id} place="top" openOnClick clickable>
        {message}
      </Tooltip>
    </>
  );
}
