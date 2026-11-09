// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SecondaryPanelActionsProvider,
  SecondaryPanelActions,
} from "@/components/secondary-panel/SecondaryPanelActions";
import {
  TerminalSizeClaimControl,
  TerminalSizeClaimSlot,
} from "./TerminalSizeClaimControl";

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

it.each([true, false])(
  "keeps the coarse-pointer header reservation stable through viewer readiness and ownership changes (coarse=%s)",
  (coarse) => {
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => ({
        matches: coarse && query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }));
    const claim = vi.fn();
    function toolbar(active: string, ready: boolean, owner: boolean) {
      return (
        <SecondaryPanelActionsProvider activeTerminalId={active}>
          <SecondaryPanelActions>
            <TerminalSizeClaimSlot />
          </SecondaryPanelActions>
          {ready && !owner && (
            <TerminalSizeClaimControl
              terminalId={active}
              touch={coarse}
              notice={false}
              onClaim={claim}
            />
          )}
          <TerminalSizeClaimControl
            terminalId="parked"
            touch={coarse}
            notice={false}
            onClaim={claim}
          />
        </SecondaryPanelActionsProvider>
      );
    }
    try {
      const view = render(toolbar("one", false, true));
      const slot = view.container.querySelector(
        "[data-terminal-size-claim-slot]",
      );
      expect(slot).not.toBeNull();
      expect(slot instanceof HTMLElement && slot.style.display).toBe(
        coarse ? "" : "none",
      );
      for (let index = 0; index < 8; index += 1) {
        for (const [ready, owner] of [
          [false, true],
          [true, false],
          [true, true],
        ]) {
          view.rerender(toolbar(`terminal-${index}`, ready, owner));
          expect(
            view.container.querySelector("[data-terminal-size-claim-slot]"),
          ).toBe(slot);
          if (coarse && ready && !owner) {
            const button = screen.getByRole("button", {
              name: "Resize to this screen",
            });
            expect(button.parentElement).toBe(slot);
            fireEvent.click(button);
          } else {
            expect(
              screen.queryByRole("button", {
                name: "Resize to this screen",
              }),
            ).toBeNull();
          }
        }
      }
      expect(claim).toHaveBeenCalledTimes(coarse ? 8 : 0);
    } finally {
      cleanup();
      matchMedia.mockRestore();
    }
  },
);
