// @vitest-environment jsdom
import { expect, it } from "vitest";
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
    fontWeight: 450,
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
  expect(parent.querySelector("pre")?.style.fontWeight).toBe("450");
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
