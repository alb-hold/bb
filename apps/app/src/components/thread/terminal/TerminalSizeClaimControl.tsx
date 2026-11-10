import { createPortal } from "react-dom";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import { useSecondaryPanelActionsTarget } from "@/components/secondary-panel/SecondaryPanelActions";

const HEADER_LABEL = "Resize to this screen";
const HEADER_BUTTON_CLASS =
  "h-11 shrink-0 rounded-md px-2 text-xs text-foreground hover:bg-state-hover";

export function TerminalSizeClaimSlot() {
  const actions = useSecondaryPanelActionsTarget();
  const touch = useMediaQuery("(pointer: coarse)");
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{
        width: "7rem",
        display:
          touch && actions?.activeTerminalId != null ? undefined : "none",
      }}
      data-terminal-size-claim-slot=""
    >
      <span
        aria-hidden="true"
        className={`invisible w-full ${HEADER_BUTTON_CLASS}`}
      >
        {HEADER_LABEL}
      </span>
    </span>
  );
}

export function TerminalSizeClaimControl({
  terminalId,
  touch,
  onClaim,
  notice,
}: {
  terminalId: string;
  touch: boolean;
  onClaim: () => void;
  notice: boolean;
}) {
  const actions = useSecondaryPanelActionsTarget();
  const inHeader = touch && actions !== null;
  const slot = inHeader
    ? actions.target?.querySelector<HTMLElement>(
        "[data-terminal-size-claim-slot]",
      )
    : null;
  const button = (
    <button
      type="button"
      data-compact-touch="code"
      style={slot ? { position: "absolute", inset: 0 } : undefined}
      className={
        inHeader
          ? `${HEADER_BUTTON_CLASS}${slot ? " w-full" : ""}`
          : "shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-state-hover"
      }
      onClick={onClaim}
    >
      {inHeader ? HEADER_LABEL : "Fit to this screen"}
    </button>
  );
  if (inHeader) {
    return actions.target !== null && actions.activeTerminalId === terminalId
      ? createPortal(button, slot ?? actions.target)
      : null;
  }
  return (
    <div
      style={{ position: "absolute" }}
      className={`right-2 z-10 flex items-center justify-end gap-2 rounded-md bg-sidebar px-2 py-1 text-xs shadow-sm ${notice ? "top-10" : "top-1"}`}
    >
      {button}
    </div>
  );
}
