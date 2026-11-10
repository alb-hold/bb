// @vitest-environment jsdom
import { renderHook, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useThreadOpenIntent } from "./useThreadOpenIntent";
import { createSettledWorkSchedule } from "@/lib/input-idle-work";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";

vi.mock("@/views/thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: { preload: vi.fn(async () => {}) },
}));
let cancel = () => {};
afterEach(() => {
  cancel();
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("pauses composer-focus warming throughout typing but keeps submit urgent", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
    window.setTimeout(callback, 1),
  );
  vi.stubGlobal("cancelIdleCallback", window.clearTimeout);
  const activity = createSettledWorkSchedule(() => true);
  cancel = activity.cancel;
  renderHook(useThreadOpenIntent);
  document.body.innerHTML =
    '<form data-app-composer=""><textarea></textarea></form>';
  const input = document.querySelector("textarea")!;
  fireEvent.input(input);
  await vi.advanceTimersByTimeAsync(500);
  fireEvent.input(input);
  await vi.advanceTimersByTimeAsync(999);
  expect(LazyThreadDetailView.preload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  expect(LazyThreadDetailView.preload).toHaveBeenCalledOnce();
  fireEvent.input(input);
  fireEvent.submit(document.querySelector("form")!);
  expect(LazyThreadDetailView.preload).toHaveBeenCalledTimes(2);
});
