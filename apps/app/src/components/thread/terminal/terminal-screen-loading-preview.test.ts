// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { mountTerminalScreenLoadingPreview } from "./terminal-screen-loading-preview";

it("shows literal snapshot rows outside xterm and removes them without changing scrollback", () => {
  const parent = document.createElement("div");
  const container = document.createElement("div");
  container.textContent = "replayed history";
  parent.append(container);
  const preview = mountTerminalScreenLoadingPreview({
    container,
    fontFamily: "monospace",
    fontSize: 18,
    lineHeight: 1.5,
    snapshot: {
      rows: ["<script>literal</script>", "next line"],
      cursor: { col: 0, row: 0 },
      cols: 40,
      gridRows: 12,
      complete: true,
      truncated: false,
    },
  });
  expect(parent.querySelector("pre")?.textContent).toBe(
    "<script>literal</script>\nnext line",
  );
  expect(parent.querySelector("script")).toBeNull();
  expect(parent.querySelector("pre")?.style.fontSize).toBe("18px");
  expect(parent.querySelector("pre")?.style.lineHeight).toBe("32px");
  expect(container.textContent).toBe("replayed history");
  expect(parent.querySelector("pre")?.style.whiteSpace).toBe("pre");
  preview.refresh(1);
  expect(parent.querySelector("pre")?.style.lineHeight).toBe("21px");
  expect(parent.querySelector("pre")?.textContent).toContain(
    "<script>literal</script>",
  );
  preview.dispose();
  preview.dispose();
  expect(parent.querySelector("pre")).toBeNull();
  expect(container.textContent).toBe("replayed history");
});

it("keeps the restoring cue until release without shifting cells or saying reconnecting", () => {
  vi.useFakeTimers();
  try {
    const parent = document.createElement("div");
    const container = document.createElement("div");
    parent.append(container);
    const preview = mountTerminalScreenLoadingPreview({
      container,
      fontFamily: "monospace",
      fontSize: 14,
      lineHeight: 1.12,
      snapshot: {
        rows: ["prompt"],
        cursor: { col: 0, row: 0 },
        cols: 40,
        gridRows: 12,
        complete: true,
        truncated: false,
      },
    });
    const notice = parent.querySelector('[role="status"]')!;
    expect(notice.textContent).toBe("Restoring session…");
    expect(notice.classList.contains("absolute")).toBe(true);
    expect(notice.classList.contains("text-muted-foreground")).toBe(true);
    const geometry = parent.querySelector("pre")!.style.cssText;
    vi.advanceTimersByTime(3700);
    expect(parent.contains(notice)).toBe(true);
    expect(parent.querySelector("pre")!.style.cssText).toBe(geometry);
    expect(parent.textContent).not.toContain("Reconnecting");
    preview.dispose();
    vi.runAllTimers();
    expect(parent.querySelector('[role="status"]')).toBeNull();
    expect(parent.children).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
