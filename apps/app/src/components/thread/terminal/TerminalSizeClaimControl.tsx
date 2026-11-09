import { createPortal } from "react-dom";
import { useSecondaryPanelActionsTarget } from "@/components/secondary-panel/SecondaryPanelActions";

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
  const button = (
    <button
      type="button"
      data-compact-touch="code"
      className={
        inHeader
          ? "h-11 shrink-0 rounded-md px-2 text-xs text-foreground hover:bg-state-hover"
          : "shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-state-hover"
      }
      onClick={onClaim}
    >
      {inHeader ? "Resize to this screen" : "Fit to this screen"}
    </button>
  );
  if (inHeader) {
    return actions.target !== null && actions.activeTerminalId === terminalId
      ? createPortal(button, actions.target)
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
