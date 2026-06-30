import { useId, type ReactNode } from "react";
import { Tooltip } from "react-tooltip";
import "react-tooltip/dist/react-tooltip.css";

/**
 * A small accessible "(?)" help icon for explaining SRS jargon (grade buttons,
 * auto-graduate, new/day vs max/day).
 *
 * Configured for touch: tap the icon to open the tooltip, tap outside to dismiss
 * (`openOnClick` + `clickable`) — not hover-only, so it works on phones.
 */
export function HelpTip({
  content,
  label = "More info",
}: {
  content: ReactNode;
  label?: string;
}) {
  // A stable, collision-free id ties this anchor to its own tooltip instance.
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="help-tip"
        aria-label={label}
        data-tooltip-id={id}
      >
        ?
      </button>
      <Tooltip id={id} place="top" openOnClick clickable>
        {content}
      </Tooltip>
    </>
  );
}
