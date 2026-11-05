// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mountTerminalScreenLoadingPreview } from "./terminal-screen-loading-preview";

it("shows literal snapshot rows outside xterm and removes them without changing scrollback", () => {
  const parent = document.createElement("div");
  const container = document.createElement("div");
  container.textContent = "replayed history";
  parent.append(container);
  const remove = mountTerminalScreenLoadingPreview({
    container,
    fontFamily: "monospace",
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
  expect(container.textContent).toBe("replayed history");
  remove();
  remove();
  expect(parent.querySelector("pre")).toBeNull();
  expect(container.textContent).toBe("replayed history");
});
