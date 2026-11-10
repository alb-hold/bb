// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.doUnmock("./ThreadDetailPromptArea");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([true, false])(
  "requests picker, voice and composer options after the timeline paints and becomes idle (native idle=%s)",
  async (nativeIdle) => {
    vi.resetModules();
    vi.useFakeTimers();
    let finishDownload = () => {};
    const download = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    const prefetch = await import("@/lib/split-prefetch");
    vi.spyOn(prefetch, "prepareSplitImport").mockReturnValue(download);
    const requested = vi.fn();
    let markRequested = () => {};
    const importRequested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    vi.doMock("./ThreadDetailPromptArea", () => {
      requested();
      markRequested();
      return { ThreadDetailPromptArea: () => <div>Composer controls</div> };
    });
    const { DeferredThreadDetailPromptArea } =
      await import("./DeferredThreadDetailPromptArea");
    const frames: FrameRequestCallback[] = [];
    const idle: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "requestIdleCallback",
      nativeIdle
        ? (callback: () => void) => {
            idle.push(callback);
            return 1;
          }
        : undefined,
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const view = render(
      <div>
        <main>Thread timeline</main>
        {createElement(DeferredThreadDetailPromptArea)}
      </div>,
    );
    expect(screen.getByRole("main").textContent).toBe("Thread timeline");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requested).not.toHaveBeenCalled();
    act(() => frames.shift()!(0));
    expect(requested).not.toHaveBeenCalled();
    act(() => frames.shift()!(0));
    expect(requested).not.toHaveBeenCalled();
    await act(async () => {
      if (nativeIdle) idle.shift()!();
      else await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(requested).not.toHaveBeenCalled();
    await act(async () => {
      finishDownload();
      await importRequested;
    });
    expect(requested).toHaveBeenCalledOnce();
    expect(screen.getByText("Composer controls")).toBeTruthy();
    view.unmount();
    render(createElement(DeferredThreadDetailPromptArea));
    expect(screen.getByText("Composer controls")).toBeTruthy();
    expect(requested).toHaveBeenCalledOnce();
  },
);

it("cancels composer requests if the thread closes before idle", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const requested = vi.fn();
  vi.doMock("./ThreadDetailPromptArea", () => {
    requested();
    return { ThreadDetailPromptArea: () => null };
  });
  const { DeferredThreadDetailPromptArea } =
    await import("./DeferredThreadDetailPromptArea");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", window.clearTimeout);
  vi.stubGlobal("requestIdleCallback", undefined);
  const view = render(createElement(DeferredThreadDetailPromptArea));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(32);
  });
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.dynamicImportSettled();
  });
  expect(requested).not.toHaveBeenCalled();
});
