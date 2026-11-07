// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(DOMTokenList.prototype, "supports").mockReturnValue(true);
});
afterEach(() => {
  document.head
    .querySelectorAll('link[rel="modulepreload"]')
    .forEach((link) => link.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preloads a module once at low priority without evaluating or fetching its source", async () => {
  const { preloadPluginModule } = await import("./plugin-module-preload");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const first = preloadPluginModule("/plugins/example.js", "low");
  const second = preloadPluginModule(
    new URL("/plugins/example.js", document.baseURI).href,
    "low",
  );
  const links = document.head.querySelectorAll<HTMLLinkElement>(
    'link[rel="modulepreload"]',
  );
  expect(links).toHaveLength(1);
  expect(links[0]!.fetchPriority).toBe("low");
  expect(links[0]!.crossOrigin).toBe("");
  let finished = false;
  void first.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  links[0]!.dispatchEvent(new Event("load"));
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await preloadPluginModule("/plugins/example.js", "low");
  expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull();
});

it("releases failed preloads so a retry can load the same URL", async () => {
  const { preloadPluginModule } = await import("./plugin-module-preload");
  const first = preloadPluginModule("/plugins/failure.js", "low");
  document.head
    .querySelector('link[rel="modulepreload"]')!
    .dispatchEvent(new Event("error"));
  expect(await first).toBe(false);
  const second = preloadPluginModule("/plugins/failure.js", "low");
  const link = document.head.querySelector('link[rel="modulepreload"]');
  expect(link).not.toBeNull();
  link!.dispatchEvent(new Event("load"));
  expect(await second).toBe(true);
});

it("settles legacy downloads without waiting for unsupported modulepreload events", async () => {
  vi.mocked(DOMTokenList.prototype.supports).mockReturnValue(false);
  const fetch = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  vi.stubGlobal("fetch", fetch);
  const { preloadPluginModule } = await import("./plugin-module-preload");
  expect(await preloadPluginModule("/plugins/legacy.js", "low")).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    new URL("/plugins/legacy.js", document.baseURI).href,
    { cache: "force-cache", priority: "low" },
  );
  expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull();
});
