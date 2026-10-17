// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceHandoffSignal } from "@bb/server-contract";
import { DeviceHandoffSheet } from "./DeviceHandoffSheet";

const copied = vi.hoisted(() => vi.fn());

vi.mock("@/lib/clipboard", () => ({
  copyToClipboardWithToast: copied,
}));

vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: vi.fn(),
}));

afterEach(() => {
  cleanup();
  copied.mockReset();
});

describe("DeviceHandoffSheet", () => {
  it("copies text only after the user taps Copy", async () => {
    copied.mockResolvedValue(true);
    const signal: DeviceHandoffSignal = {
      type: "device-handoff",
      id: "handoff-1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 120_000,
      originLabel: "Terminal",
      request: {
        kind: "copy-text",
        text: "secret-free test text",
        origin: { terminalSessionId: "term_1" },
      },
    };
    const onDismiss = vi.fn();
    render(<DeviceHandoffSheet signal={signal} onDismiss={onDismiss} />);

    expect(copied).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(copied).toHaveBeenCalledWith("secret-free test text", {
      successMessage: "Copied on this device",
      errorMessage: "Could not copy text",
    });
  });
});
