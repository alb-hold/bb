// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationHub } from "../../../../../server/src/ws/hub.js";
import { listenForTerminalSizeClaims } from "./terminal-size-claims";

function terminalElement(size: { width: number; height: number }) {
  const element = document.createElement("div");
  const textarea = document.createElement("textarea");
  element.append(textarea);
  document.body.append(element);
  vi.spyOn(element, "clientWidth", "get").mockImplementation(() => size.width);
  vi.spyOn(element, "clientHeight", "get").mockImplementation(
    () => size.height,
  );
  return { element, textarea };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("terminal size claims", () => {
  it.each(["keydown", "paste", "pointerdown"])(
    "reclaims the real shared PTY on %s immediately after another device claims it",
    (eventType) => {
      vi.spyOn(Date, "now").mockReturnValue(10_000);
      const hub = new NotificationHub();
      const desktop = terminalElement({ width: 1200, height: 800 });
      const phone = terminalElement({ width: 400, height: 600 });
      const desktopSocket = { close: () => {}, send: () => {} };
      const phoneSocket = { close: () => {}, send: () => {} };
      const terminalId = "terminal-reclaim";
      const desktopSize = { cols: 120, rows: 40 };
      const phoneSize = { cols: 80, rows: 20 };
      hub.registerTerminalClient(terminalId, desktopSocket);
      hub.registerTerminalClient(terminalId, phoneSocket);
      hub.recordTerminalClientSize(
        terminalId,
        desktopSocket,
        desktopSize,
        Date.now(),
      );
      hub.recordTerminalClientSize(
        terminalId,
        phoneSocket,
        phoneSize,
        Date.now(),
      );
      const desktopClaims = listenForTerminalSizeClaims({
        ...desktop,
        claim: () =>
          hub.recordTerminalClientSize(
            terminalId,
            desktopSocket,
            desktopSize,
            Date.now(),
            true,
          ),
      });
      const phoneClaims = listenForTerminalSizeClaims({
        ...phone,
        claim: () =>
          hub.recordTerminalClientSize(
            terminalId,
            phoneSocket,
            phoneSize,
            Date.now(),
            true,
          ),
      });
      try {
        desktop.textarea.focus();
        expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual(
          desktopSize,
        );
        phone.textarea.dispatchEvent(new Event("paste", { bubbles: true }));
        expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual(
          phoneSize,
        );
        expect(document.activeElement).toBe(desktop.textarea);
        desktop.textarea.dispatchEvent(new Event(eventType, { bubbles: true }));
        expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual(
          desktopSize,
        );
        const backgroundSize = { cols: 75, rows: 18 };
        hub.recordTerminalClientSize(
          terminalId,
          phoneSocket,
          backgroundSize,
          Date.now(),
        );
        expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual(
          desktopSize,
        );
        hub.recordTerminalClientVisibility(
          terminalId,
          desktopSocket,
          false,
          Date.now(),
        );
        expect(hub.terminalSharedSize(terminalId, Date.now())).toEqual(
          backgroundSize,
        );
      } finally {
        desktopClaims.dispose();
        phoneClaims.dispose();
        hub.unregisterTerminalClient(terminalId, desktopSocket);
        hub.unregisterTerminalClient(terminalId, phoneSocket);
      }
    },
  );

  it("claims the shared PTY when this device is used, not when it mounts or resizes", () => {
    const size = { width: 800, height: 400 };
    const { element, textarea } = terminalElement(size);
    const claim = vi.fn();
    const claims = listenForTerminalSizeClaims({
      claim,
      element,
      textarea,
    });

    element.dispatchEvent(new Event("resize"));
    expect(claim).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    expect(claim).toHaveBeenCalledTimes(1);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    element.dispatchEvent(new Event("paste", { bubbles: true }));
    expect(claim).toHaveBeenCalledTimes(3);

    element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(claim).toHaveBeenCalledTimes(4);

    textarea.dispatchEvent(new FocusEvent("focus"));
    expect(claim).toHaveBeenCalledTimes(5);

    claims.claimIfFocused();
    expect(claim).toHaveBeenCalledTimes(5);
    textarea.focus();
    expect(claim).toHaveBeenCalledTimes(6);
    claims.claimIfFocused();
    expect(claim).toHaveBeenCalledTimes(7);

    size.width = 0;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    claims.claimIfFocused();
    expect(claim).toHaveBeenCalledTimes(7);

    size.width = 800;
    claims.dispose();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent("focus"));
    expect(claim).toHaveBeenCalledTimes(7);
  });
});
