// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--font-terminal");
  vi.restoreAllMocks();
});

function container(width = 936, height = 662) {
  const element = document.createElement("div");
  element.dataset.terminalGridCacheId = "term";
  element.dataset.terminalFontSize = "13";
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, width, height),
  );
  return element;
}

it("persists the fitted grid across a browser module reload, using the last rect before mount", async () => {
  const cache = await import("./terminal-grid-cache");
  cache.rememberTerminalGrid("term", container(), 13, { cols: 116, rows: 38 });
  vi.resetModules();
  const reloaded = await import("./terminal-grid-cache");
  expect(reloaded.readCachedTerminalGrid("term")).toEqual({
    cols: 116,
    rows: 38,
  });
  expect(reloaded.readCachedTerminalGrid("other")).toBeNull();
});

it.each([
  "viewportWidth",
  "viewportHeight",
  "dpr",
  "fontSize",
  "fontFamily",
  "width",
  "height",
])("misses when the current %s differs", async (changed) => {
  const cache = await import("./terminal-grid-cache");
  cache.rememberTerminalGrid("term", container(), 13, { cols: 116, rows: 38 });
  let fontSize = 13;
  if (changed === "viewportWidth")
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
  if (changed === "viewportHeight")
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
  if (changed === "dpr")
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
  if (changed === "fontSize") fontSize = 14;
  if (changed === "fontFamily")
    document.documentElement.style.setProperty("--font-terminal", "monospace");
  if (changed === "width" || changed === "height") {
    document.body.append(
      container(
        changed === "width" ? 800 : 936,
        changed === "height" ? 600 : 662,
      ),
    );
  }
  expect(cache.readCachedTerminalGrid("term", fontSize)).toBeNull();
});

it("matches container dimensions rounded to whole pixels", async () => {
  const cache = await import("./terminal-grid-cache");
  cache.rememberTerminalGrid("term", container(935.9, 662.1), 13, {
    cols: 116,
    rows: 38,
  });
  document.body.append(container(936.1, 661.9));
  expect(cache.readCachedTerminalGrid("term")).toEqual({ cols: 116, rows: 38 });
});

it("matches the font actually used for the fit, including a pending font-family change", async () => {
  const cache = await import("./terminal-grid-cache");
  document.documentElement.style.setProperty("--font-terminal", "new-font");
  cache.rememberTerminalGrid(
    "term",
    container(),
    13,
    { cols: 116, rows: 38 },
    "old-font",
  );
  expect(cache.readCachedTerminalGrid("term")).toBeNull();
  document.documentElement.style.setProperty("--font-terminal", "old-font");
  expect(cache.readCachedTerminalGrid("term")).toEqual({ cols: 116, rows: 38 });
});

it("keeps multiple pane sizes and uses the most recently fitted rect before mount", async () => {
  const cache = await import("./terminal-grid-cache");
  cache.rememberTerminalGrid("term", container(), 13, { cols: 116, rows: 38 });
  cache.rememberTerminalGrid("term", container(800), 13, {
    cols: 99,
    rows: 38,
  });
  expect(cache.readCachedTerminalGrid("term")).toEqual({ cols: 99, rows: 38 });
  const mounted = container();
  document.body.append(mounted);
  expect(cache.readCachedTerminalGrid("term")).toEqual({ cols: 116, rows: 38 });
  cache.rememberTerminalGrid("term", mounted, 13, { cols: 116, rows: 38 });
  mounted.remove();
  expect(cache.readCachedTerminalGrid("term")).toEqual({ cols: 116, rows: 38 });
});

it.each(["getItem", "setItem"] as const)(
  "keeps a memory fallback if storage %s throws",
  async (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const cache = await import("./terminal-grid-cache");
    cache.rememberTerminalGrid("term", container(), 13, {
      cols: 116,
      rows: 38,
    });
    expect(cache.readCachedTerminalGrid("term")).toEqual({
      cols: 116,
      rows: 38,
    });
  },
);

it("bounds persisted contexts and rejects malformed or unmeasurable grids", async () => {
  const cache = await import("./terminal-grid-cache");
  for (let index = 0; index < 40; index++) {
    cache.rememberTerminalGrid(`term-${index}`, container(), 13, {
      cols: 116,
      rows: 38,
    });
  }
  expect(cache.readCachedTerminalGrid("term-0")).toBeNull();
  expect(cache.readCachedTerminalGrid("term-39")).toEqual({
    cols: 116,
    rows: 38,
  });
  const key = localStorage.key(0)!;
  expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(32);
  cache.rememberTerminalGrid("invalid", container(0), 13, {
    cols: 116,
    rows: 38,
  });
  expect(cache.readCachedTerminalGrid("invalid")).toBeNull();
  cache.rememberTerminalGrid("oversized", container(), 13, {
    cols: 501,
    rows: 201,
  });
  expect(cache.readCachedTerminalGrid("oversized")).toBeNull();
  localStorage.setItem(key, '[{"terminalId":"term","cols":-1}]');
  vi.resetModules();
  expect(
    (await import("./terminal-grid-cache")).readCachedTerminalGrid("term"),
  ).toBeNull();
});

it.each(["lineHeight", "fontWeight"])(
  "rejects a grid fitted with stale %s",
  async (metric) => {
    const cache = await import("./terminal-grid-cache");
    cache.rememberTerminalGrid("term", container(), 13, {
      cols: 116,
      rows: 38,
    });
    const key = localStorage.key(0)!;
    const entries = JSON.parse(localStorage.getItem(key)!);
    entries[0][metric] = metric === "lineHeight" ? 1.12 : 700;
    localStorage.setItem(key, JSON.stringify(entries));
    expect(cache.readCachedTerminalGrid("term")).toBeNull();
  },
);

it("rejects a legacy cache entry with no leading or weight", async () => {
  const cache = await import("./terminal-grid-cache");
  cache.rememberTerminalGrid("term", container(), 13, { cols: 116, rows: 38 });
  const key = localStorage.key(0)!;
  const entries = JSON.parse(localStorage.getItem(key)!);
  delete entries[0].lineHeight;
  delete entries[0].fontWeight;
  localStorage.setItem(key, JSON.stringify(entries));
  vi.resetModules();
  const reloaded = await import("./terminal-grid-cache");
  expect(() => reloaded.readCachedTerminalGrid("term")).not.toThrow();
  expect(reloaded.readCachedTerminalGrid("term")).toBeNull();
  reloaded.rememberTerminalGrid("term", container(), 13, {
    cols: 116,
    rows: 36,
  });
  expect(reloaded.readCachedTerminalGrid("term")).toEqual({
    cols: 116,
    rows: 36,
  });
});

it("reuses measured metrics across repeated grid reads", async () => {
  const cache = await import("./terminal-grid-cache");
  cache.rememberTerminalGrid("term", container(), 13, { cols: 116, rows: 38 });
  const create = vi.spyOn(document, "createElement");
  for (let index = 0; index < 10; index++)
    expect(cache.readCachedTerminalGrid("term")).toEqual({
      cols: 116,
      rows: 38,
    });
  expect(create).not.toHaveBeenCalled();
});

it.each(["shell", "panel", "split"])(
  "misses before mount when the surrounding %s layout changes at the same viewport",
  async (kind) => {
    const shell = document.createElement("div");
    if (kind === "shell") shell.dataset.testid = "app-layout-content-shell";
    if (kind === "panel") shell.setAttribute("data-panel", "");
    if (kind === "split") shell.dataset.splitPaneId = "pane-1";
    document.body.append(shell);
    const rect = vi
      .spyOn(shell, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(256, 0, 936, 800));
    const cache = await import("./terminal-grid-cache");
    cache.rememberTerminalGrid("term", container(), 13, {
      cols: 116,
      rows: 38,
    });
    expect(cache.readCachedTerminalGrid("term")).toEqual({
      cols: 116,
      rows: 38,
    });
    rect.mockReturnValue(new DOMRect(400, 0, 792, 800));
    expect(cache.readCachedTerminalGrid("term")).toBeNull();
  },
);
