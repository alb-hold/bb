// @vitest-environment jsdom
import { render, renderHook, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { ThreadModeGlyph } from "@bb/shared-ui/thread-mode-glyph";
import { preloadTerminalModules } from "@/components/thread/terminal/terminal-modules";
import { downloadSplit } from "@/lib/split-prefetch";
import { useThreadOpenIntent } from "./useThreadOpenIntent";
import { prefetchThreadOpen } from "@/lib/thread-open-prefetch";
import { warmSplitWhenQuiet } from "@/lib/settled-split-downloads";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";

vi.mock("@/components/thread/terminal/terminal-modules", () => ({
  preloadTerminalModules: vi.fn(),
}));
vi.mock("@/lib/split-prefetch", () => ({ downloadSplit: vi.fn() }));
vi.mock("@/lib/settled-split-downloads", () => ({
  warmSplitWhenQuiet: vi.fn(),
}));
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

it.each(["touchStart", "focusIn"])(
  "warms a sidebar destination on %s",
  async (event) => {
    renderHook(useThreadOpenIntent);
    const row = document.createElement("button");
    row.dataset.sidebarThreadId = "other";
    document.body.append(row);
    if (event === "touchStart") fireEvent.touchStart(row);
    else fireEvent.focusIn(row);
    await vi.waitFor(() =>
      expect(prefetchThreadOpen).toHaveBeenCalledWith("other"),
    );
  },
);

it.each(["focus", "input", "submit"])(
  "warms the chat view on home composer %s without terminal code",
  async (event) => {
    window.history.replaceState(null, "", "/");
    renderHook(useThreadOpenIntent);
    document.body.innerHTML =
      '<form data-app-composer=""><textarea></textarea></form>';
    const input = document.querySelector("textarea")!;
    fireEvent.focusIn(input);
    expect(LazyThreadDetailView.preload).not.toHaveBeenCalled();
    if (event === "focus") {
      fireEvent.keyDown(document, { key: "Tab" });
      fireEvent.focusIn(input);
    } else if (event === "input") fireEvent.input(input);
    else fireEvent.submit(document.querySelector("form")!);
    if (event === "submit")
      expect(LazyThreadDetailView.preload).toHaveBeenCalledOnce();
    else {
      expect(LazyThreadDetailView.preload).not.toHaveBeenCalled();
      expect(warmSplitWhenQuiet).toHaveBeenCalledWith(
        "thread-detail",
        expect.any(Function),
      );
      await vi.mocked(warmSplitWhenQuiet).mock.calls[0]![1]();
      expect(LazyThreadDetailView.preload).toHaveBeenCalledOnce();
    }
    await Promise.resolve();
    expect(preloadTerminalModules).not.toHaveBeenCalled();
  },
);

it("warms terminal modules immediately for explicit native-terminal composer intent", async () => {
  renderHook(useThreadOpenIntent);
  document.body.innerHTML =
    '<div data-app-composer="" data-native-terminal="true"><textarea></textarea></div>';
  fireEvent.input(document.querySelector("textarea")!);
  expect(downloadSplit).toHaveBeenCalledWith("thread-terminal");
  await vi.waitFor(() => expect(preloadTerminalModules).toHaveBeenCalledOnce());
  expect(LazyThreadDetailView.preload).toHaveBeenCalledOnce();
  expect(warmSplitWhenQuiet).not.toHaveBeenCalled();
});

it.each(["sidebar", "recent"])(
  "prepares a native terminal on %s row intent",
  async (surface) => {
    renderHook(useThreadOpenIntent);
    const row =
      surface === "sidebar"
        ? document.createElement("button")
        : document.createElement("a");
    if (row instanceof HTMLAnchorElement) row.href = "/threads/native";
    else row.dataset.sidebarThreadId = "native";
    document.body.append(row);
    render(
      createElement(ThreadModeGlyph, {
        nativeTerminal: true,
        isWorktree: false,
      }),
      { container: row },
    );
    fireEvent.pointerOver(row.firstElementChild!);
    expect(downloadSplit).toHaveBeenCalledWith("thread-terminal");
    await vi.waitFor(() =>
      expect(preloadTerminalModules).toHaveBeenCalledOnce(),
    );
    expect(prefetchThreadOpen).toHaveBeenCalledWith("native");
  },
);

it.each(["pointerDown", "touchStart", "focusIn"])(
  "prepares a native terminal on %s",
  async (event) => {
    renderHook(useThreadOpenIntent);
    const row = document.createElement("button");
    row.dataset.sidebarThreadId = "native";
    document.body.append(row);
    render(
      createElement(ThreadModeGlyph, {
        nativeTerminal: true,
        isWorktree: false,
      }),
      { container: row },
    );
    if (event === "pointerDown") fireEvent.pointerDown(row);
    else if (event === "touchStart") fireEvent.touchStart(row);
    else fireEvent.focusIn(row);
    await vi.waitFor(() =>
      expect(preloadTerminalModules).toHaveBeenCalledOnce(),
    );
  },
);

it("warms notification and deep-link destinations without sidebar rows", async () => {
  renderHook(useThreadOpenIntent);
  const link = document.createElement("a");
  link.href = "/projects/project/threads/notified";
  document.body.append(link);
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  await vi.waitFor(() =>
    expect(prefetchThreadOpen).toHaveBeenCalledWith("notified"),
  );
});
