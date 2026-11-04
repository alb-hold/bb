// @vitest-environment jsdom
import { renderHook, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useThreadOpenIntent } from "./useThreadOpenIntent";
import { prefetchThreadOpen } from "@/lib/thread-open-prefetch";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";

vi.mock("@/lib/thread-open-prefetch", () => ({ prefetchThreadOpen: vi.fn() }));
vi.mock("@/views/thread-detail/LazyThreadDetailView", () => ({
  LazyThreadDetailView: { preload: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

it("warms only on row hover or focus, including plugin rows, and removes listeners", async () => {
  const { unmount } = renderHook(useThreadOpenIntent);
  expect(LazyThreadDetailView.preload).not.toHaveBeenCalled();
  const row = document.createElement("button");
  row.dataset.sidebarThreadId = "native";
  const child = document.createElement("span");
  row.append(child);
  document.body.append(row);
  fireEvent.pointerOver(child);
  await vi.waitFor(() =>
    expect(prefetchThreadOpen).toHaveBeenCalledWith("native"),
  );
  child.dispatchEvent(
    new MouseEvent("pointerover", { bubbles: true, relatedTarget: row }),
  );
  expect(LazyThreadDetailView.preload).toHaveBeenCalledOnce();
  fireEvent.focusIn(row);
  expect(LazyThreadDetailView.preload).toHaveBeenCalledTimes(2);
  unmount();
  fireEvent.focusIn(row);
  expect(LazyThreadDetailView.preload).toHaveBeenCalledTimes(2);
});
