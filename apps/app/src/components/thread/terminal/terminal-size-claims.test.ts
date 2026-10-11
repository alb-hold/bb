// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("claims the shared PTY when this device is used, not when it mounts or resizes", () => {
    const size = { width: 800, height: 400 };
    const { element, textarea } = terminalElement(size);
    let time = 10_000;
    const claim = vi.fn();
    const claims = listenForTerminalSizeClaims({
      claim,
      element,
      now: () => time,
      textarea,
    });

    element.dispatchEvent(new Event("resize"));
    expect(claim).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    expect(claim).toHaveBeenCalledTimes(1);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    element.dispatchEvent(new Event("paste", { bubbles: true }));
    expect(claim).toHaveBeenCalledTimes(1);

    time += 1_001;
    element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(claim).toHaveBeenCalledTimes(2);

    textarea.dispatchEvent(new FocusEvent("focus"));
    expect(claim).toHaveBeenCalledTimes(3);

    claims.claimIfFocused();
    expect(claim).toHaveBeenCalledTimes(3);
    textarea.focus();
    expect(claim).toHaveBeenCalledTimes(4);
    claims.claimIfFocused();
    expect(claim).toHaveBeenCalledTimes(5);

    size.width = 0;
    time += 1_001;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    claims.claimIfFocused();
    expect(claim).toHaveBeenCalledTimes(5);

    size.width = 800;
    claims.dispose();
    time += 1_001;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent("focus"));
    expect(claim).toHaveBeenCalledTimes(5);
  });
});
