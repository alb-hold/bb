// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SecondaryPanelActionsProvider,
  SecondaryPanelActions,
} from "@/components/secondary-panel/SecondaryPanelActions";
import { TerminalSizeClaimControl } from "./TerminalSizeClaimControl";

afterEach(cleanup);
it("moves the touch size claim into the active drawer toolbar", () => {
  const claim = vi.fn();
  const view = render(
    <SecondaryPanelActionsProvider activeTerminalId="one">
      <SecondaryPanelActions />
      <TerminalSizeClaimControl
        terminalId="one"
        touch
        notice={false}
        onClaim={claim}
      />
    </SecondaryPanelActionsProvider>,
  );
  const button = screen.getByRole("button", { name: "Resize to this screen" });
  expect(button.closest("[data-secondary-panel-actions]")).not.toBeNull();
  fireEvent.click(button);
  expect(claim).toHaveBeenCalledOnce();
  view.rerender(
    <SecondaryPanelActionsProvider activeTerminalId="two">
      <SecondaryPanelActions />
      <TerminalSizeClaimControl
        terminalId="one"
        touch
        notice={false}
        onClaim={claim}
      />
    </SecondaryPanelActionsProvider>,
  );
  expect(screen.queryByRole("button")).toBeNull();
});
