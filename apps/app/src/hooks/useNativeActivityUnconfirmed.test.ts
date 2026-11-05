// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ThreadRuntimeState } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeActivityUnconfirmed } from "./useNativeActivityUnconfirmed";

const START_MS = 1_800_000_000_500;
const FRESH_FOR_MS = 90_000;

function confirmedRuntime(lastEvidenceAt: number): ThreadRuntimeState {
  return {
    displayStatus: "active",
    nativeActivity: {
      lastEvidenceAt,
      freshForMs: FRESH_FOR_MS,
      confirmation: "confirmed",
      evidenceKind: "holder-report",
    },
  };
}

function setDocumentVisibility(state: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function renderUnconfirmed(initial: ThreadRuntimeState) {
  const seen: boolean[] = [];
  const hook = renderHook(
    ({ runtime }: { runtime: ThreadRuntimeState }) => {
      const unconfirmed = useNativeActivityUnconfirmed(runtime);
      seen.push(unconfirmed);
      return unconfirmed;
    },
    { initialProps: { runtime: initial } },
  );
  return { ...hook, seen };
}

describe("useNativeActivityUnconfirmed", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("never reports a receipt stamped between two ticks as unconfirmed", () => {
    vi.useFakeTimers({ now: START_MS });
    const { rerender, seen, unmount } = renderUnconfirmed(
      confirmedRuntime(START_MS - 1_000),
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    seen.length = 0;

    rerender({ runtime: confirmedRuntime(Date.now()) });

    expect(seen).not.toContain(true);
    unmount();
  });

  it("does not flash the notice on the render where activity first appears on a quiet page", () => {
    vi.useFakeTimers({ now: START_MS });
    const seen: boolean[] = [];
    const { rerender, unmount } = renderHook(
      ({ runtime }: { runtime: ThreadRuntimeState }) => {
        const unconfirmed = useNativeActivityUnconfirmed(runtime);
        seen.push(unconfirmed);
        return unconfirmed;
      },
      { initialProps: { runtime: { displayStatus: "idle" } } },
    );
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    seen.length = 0;

    rerender({ runtime: confirmedRuntime(Date.now()) });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(true);
    unmount();
  });

  it("follows a receipt that arrives while the page is hidden", () => {
    vi.useFakeTimers({ now: START_MS });
    const { rerender, result, unmount } = renderUnconfirmed(
      confirmedRuntime(START_MS),
    );
    act(() => {
      setDocumentVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    rerender({ runtime: confirmedRuntime(Date.now()) });

    expect(result.current).toBe(false);
    unmount();
  });

  it("still reports a silent session once its last receipt is older than the freshness window", () => {
    vi.useFakeTimers({ now: START_MS });
    const { result, unmount } = renderUnconfirmed(confirmedRuntime(START_MS));
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(FRESH_FOR_MS + 1_000);
    });

    expect(result.current).toBe(true);
    unmount();
  });

  it("reports a session whose receipt is already stale when the page loads", () => {
    vi.useFakeTimers({ now: START_MS });
    const { result, unmount } = renderUnconfirmed(
      confirmedRuntime(START_MS - FRESH_FOR_MS - 5_000),
    );

    expect(result.current).toBe(true);
    unmount();
  });

  it("reports a session the server marks unconfirmed", () => {
    vi.useFakeTimers({ now: START_MS });
    const { result, unmount } = renderUnconfirmed({
      displayStatus: "active",
      nativeActivity: {
        lastEvidenceAt: null,
        freshForMs: FRESH_FOR_MS,
        confirmation: "unconfirmed",
        evidenceKind: "unknown",
      },
    });

    expect(result.current).toBe(true);
    unmount();
  });
});
