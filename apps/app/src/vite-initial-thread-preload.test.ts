import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { initialThreadPreload } from "../vite-initial-thread-preload";

function bootstrap(pathname: string, view: unknown, ok = true) {
  const plugin = initialThreadPreload();
  const hook = plugin.transformIndexHtml;
  if (!hook || typeof hook !== "object") throw new Error("Missing HTML hook");
  const chunk = (fileName: string, module: string, imports: string[] = []) => ({
    type: "chunk" as const, fileName, modules: { [module]: {} }, imports,
  });
  const handler = hook.handler as (html: string, context: unknown) => Array<{ children: string; injectTo: string }>;
  const tags = handler("", { bundle: {
    "thread.js": chunk("thread.js", "/app/src/views/thread-detail/ThreadDetailView.tsx", ["shared.js"]),
    "terminal.js": chunk("terminal.js", "/node_modules/@xterm/xterm/lib/xterm.mjs", ["shared.js"]),
    "webgl.js": chunk("webgl.js", "/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs"),
    "panel.js": chunk("panel.js", "/app/src/components/thread/terminal/ThreadTerminalPanel.tsx"),
    "terminal-view.js": chunk("terminal-view.js", "/node_modules/@xterm/xterm/css/xterm.css"),
    "shared.js": chunk("shared.js", "/app/shared.ts"),
    "other.js": chunk("other.js", "/app/settings.ts"),
  }});
  const links: Array<{ href: string; rel: string; fetchPriority: string }> = [];
  const timer = vi.fn();
  let fallback = () => {};
  const setTimeout = vi.fn((callback: () => void, _ms: number) => { fallback = callback; return 1; });
  let resolve: (response: unknown) => void = () => {};
  const fetch = vi.fn(() => new Promise((r) => { resolve = r; }));
  const document = { createElement: () => ({}), head: { append: (link: { href: string; rel: string; fetchPriority: string }) => links.push(link) } };
  runInNewContext(tags[0]!.children, { document, location: { pathname }, fetch, setTimeout, clearTimeout: timer });
  return { links, fetch, tags, setTimeout, timer, fallback: () => fallback(), respond: async () => {
    resolve({ ok, json: async () => view });
    await new Promise((r) => globalThis.setTimeout(r, 0));
  } };
}

it.each(["/threads/thr_abc", "/projects/proj_a/threads/thr_abc/"])("fetches the route before shell execution on %s and native assets after identity lookup", async (path) => {
  const state = bootstrap(path, { threadId: "thr_abc", providerId: "codex" });
  expect(state.tags[0]!.injectTo).toBe("head-prepend");
  expect(state.links.map((link) => link.href)).toEqual(["/thread.js", "/shared.js"]);
  expect(state.fetch).toHaveBeenCalledWith("/api/v1/threads/thr_abc/native-terminal");
  await state.respond();
  expect(state.links.map((link) => link.href)).toEqual(["/thread.js", "/shared.js", "/terminal.js", "/webgl.js", "/panel.js"]);
  expect(state.links.every((link) => link.rel === "modulepreload")).toBe(true);
  expect(state.links.every((link) => link.fetchPriority === "auto")).toBe(true);
  expect(state.timer).toHaveBeenCalledWith(1);
});

it.each(["/", "/settings", "/threads", "/threads/a/messages", "/projects/p"])("leaves unrelated route %s untouched", (path) => {
  const state = bootstrap(path, null);
  expect(state.links).toEqual([]);
  expect(state.fetch).not.toHaveBeenCalled();
});

it.each([null, { threadId: "other", providerId: "codex" }, {}, "native"])("does not fetch terminal assets for chat or malformed metadata %j", async (view) => {
  const state = bootstrap("/threads/thr_abc", view);
  await state.respond();
  expect(state.links.map((link) => link.href)).toEqual(["/thread.js", "/shared.js"]);
  expect(state.timer).toHaveBeenCalledWith(1);
});

it("does not fetch terminal assets on HTTP failure", async () => {
  const state = bootstrap("/threads/thr_abc", { threadId: "thr_abc", providerId: "codex" }, false);
  await state.respond();
  expect(state.links).toHaveLength(2);
});

it("starts only terminal runtimes at low priority after 50ms and deduplicates on native confirmation", async () => {
  const state = bootstrap("/threads/thr_abc", { threadId: "thr_abc", providerId: "codex" });
  expect(state.setTimeout).toHaveBeenCalledWith(expect.any(Function), 50);
  state.fallback();
  expect(state.links.map((link) => link.href)).toEqual(["/thread.js", "/shared.js", "/terminal.js", "/webgl.js"]);
  expect(state.links.slice(2).map((link) => link.fetchPriority)).toEqual(["low", "low"]);
  await state.respond();
  expect(state.links.map((link) => link.href)).toEqual(["/thread.js", "/shared.js", "/terminal.js", "/webgl.js", "/panel.js"]);
  expect(state.links.at(-1)?.fetchPriority).toBe("auto");
});
