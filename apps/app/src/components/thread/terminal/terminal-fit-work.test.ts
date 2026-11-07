// @vitest-environment jsdom

import { expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalFitWork } from "./terminal-fit-work";

function setup() {
  const size = { width: 900, height: 500 };
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  const cell = { width: 9, height: 18 };
  const terminal = {
    cols: 98,
    rows: 27,
    dimensions: {
      css: { cell, canvas: { width: 882, height: 486 } },
      device: {
        cell,
        canvas: { width: 882, height: 486 },
        char: { width: 9, height: 18, top: 0, left: 0 },
      },
    },
    options: {
      fontFamily: "monospace",
      fontSize: 13,
      fontWeight: 400,
      lineHeight: 1.22,
      letterSpacing: 0,
      scrollback: 1000,
      scrollbar: { width: 14, showScrollbar: true },
    },
  } satisfies Pick<Terminal, "cols" | "rows" | "dimensions" | "options">;
  const work = vi.fn(() => true);
  const input = {
    container,
    terminal,
    ptyGrid: { cols: 98, rows: 27 },
    layoutSettled: true,
    rendererSettled: true,
    retainedOutputReplayed: false,
    work,
  };
  const fit = createTerminalFitWork();
  return { fit, input, run: () => fit.run(input), cell, size, work };
}

it("does no more fit, cache or presentation work on repeated unchanged focus", () => {
  const h = setup();
  h.run();
  for (let i = 0; i < 60; i++) h.run();
  expect(h.work).toHaveBeenCalledTimes(1);
});

it.each([
  "container",
  "cell",
  "PTY grid",
  "render grid",
  "font",
  "scrollbar",
  "layout readiness",
  "renderer readiness",
  "retained replay",
] as const)("refits after %s changes", (change) => {
  const h = setup();
  h.run();
  switch (change) {
    case "container":
      h.size.width = 700;
      break;
    case "cell":
      h.cell.width = 10;
      break;
    case "PTY grid":
      h.input.ptyGrid.cols = 80;
      break;
    case "render grid":
      h.input.terminal.rows = 30;
      break;
    case "font":
      h.input.terminal.options.fontSize = 15;
      break;
    case "scrollbar":
      h.input.terminal.options.scrollbar.width = 18;
      break;
    case "layout readiness":
      h.input.layoutSettled = false;
      break;
    case "renderer readiness":
      h.input.rendererSettled = false;
      break;
    case "retained replay":
      h.input.retainedOutputReplayed = true;
  }
  h.run();
  h.run();
  expect(h.work).toHaveBeenCalledTimes(2);
});

it("retries unavailable fit results and unmeasured cells", () => {
  const h = setup();
  h.work.mockReturnValueOnce(false);
  h.run();
  h.run();
  h.run();
  expect(h.work).toHaveBeenCalledTimes(2);
  h.cell.width = 0;
  h.run();
  h.run();
  expect(h.work).toHaveBeenCalledTimes(4);
});

it("refits when font loading invalidates unchanged cell measurements", () => {
  const h = setup();
  h.run();
  h.fit.invalidate();
  h.run();
  h.run();
  expect(h.work).toHaveBeenCalledTimes(2);
});
