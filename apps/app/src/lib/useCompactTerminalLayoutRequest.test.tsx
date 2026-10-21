// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useCompactTerminalLayoutRequest,
  type CompactTerminalLayoutRequest,
} from "./useCompactTerminalLayoutRequest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useCompactTerminalLayoutRequest", () => {
  it("consumes a compact split while the drawer is closed so it cannot apply after widening", async () => {
    const request: CompactTerminalLayoutRequest = {
      action: "split",
      requestId: 71,
      side: "right",
      terminalId: "term-compact-closed-drawer",
    };
    const ensureTerminalTabs = vi.fn(() => true);
    const onResolved = vi.fn();
    const { result, rerender } = renderHook(({ compact, drawerOpen }) => {
      const [currentRequest, setCurrentRequest] = useState<CompactTerminalLayoutRequest | null>(request);
      useCompactTerminalLayoutRequest({
        enabled: compact && !drawerOpen,
        ensureTerminalTabs,
        onHandled: (requestId) => {
          if (currentRequest?.requestId === requestId) setCurrentRequest(null);
        },
        onResolved,
        request: currentRequest,
      });
      return currentRequest;
    }, { initialProps: { compact: true, drawerOpen: false } });

    await waitFor(() => expect(result.current).toBeNull());

    expect(ensureTerminalTabs).toHaveBeenCalledWith([request.terminalId]);
    expect(onResolved).toHaveBeenCalledWith(true);

    rerender({ compact: false, drawerOpen: false });

    expect(result.current).toBeNull();
    expect(ensureTerminalTabs).toHaveBeenCalledTimes(1);
  });

  it("retries after terminal data becomes available and shows unavailable status when needed", async () => {
    const request: CompactTerminalLayoutRequest = {
      action: "move",
      requestId: 72,
      terminalId: "term-source",
      targetTerminalId: "term-target",
    };
    const ensurePending = vi.fn<(terminalIds: readonly string[]) => boolean | null>(() => null);
    const onResolved = vi.fn();
    const { rerender } = renderHook(
      ({ ensureTerminalTabs }) =>
        useCompactTerminalLayoutRequest({
          enabled: true,
          ensureTerminalTabs,
          onResolved,
          request,
        }),
      { initialProps: { ensureTerminalTabs: ensurePending } },
    );

    expect(ensurePending).toHaveBeenCalledWith(["term-target", "term-source"]);
    expect(onResolved).not.toHaveBeenCalled();

    const ensureUnavailable = vi.fn<(terminalIds: readonly string[]) => boolean | null>(() => false);
    act(() => rerender({ ensureTerminalTabs: ensureUnavailable }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(false));
    expect(ensureUnavailable).toHaveBeenCalledWith(["term-target", "term-source"]);
  });

  it("selects a terminal after the compact request refreshes a stale terminal list", async () => {
    const request: CompactTerminalLayoutRequest = {
      action: "split",
      requestId: 73,
      side: "right",
      terminalId: "term-created-by-cli",
    };
    const ensureBeforeRefresh = vi.fn<(terminalIds: readonly string[]) => boolean | null>(
      () => null,
    );
    const ensureAfterRefresh = vi.fn<(terminalIds: readonly string[]) => boolean | null>(
      () => true,
    );
    const onHandled = vi.fn();
    const onResolved = vi.fn();
    const { rerender } = renderHook(
      ({ ensureTerminalTabs }) =>
        useCompactTerminalLayoutRequest({
          enabled: true,
          ensureTerminalTabs,
          onHandled,
          onResolved,
          request,
        }),
      { initialProps: { ensureTerminalTabs: ensureBeforeRefresh } },
    );

    expect(ensureBeforeRefresh).toHaveBeenCalledWith([request.terminalId]);
    expect(onHandled).not.toHaveBeenCalled();

    rerender({ ensureTerminalTabs: ensureAfterRefresh });

    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(request.requestId));
    expect(onResolved).toHaveBeenCalledWith(true);
  });
});
