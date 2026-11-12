import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { initialThreadPreload } from "../vite-initial-thread-preload";

function bootstrap(pathname: string, view: unknown, ok = true) {
  const plugin = initialThreadPreload();
  const hook = plugin.transformIndexHtml;
  if (!hook || typeof hook !== "object") throw new Error("Missing HTML hook");
  const chunk = (fileName: string, module: string, imports: string[] = []) => ({
    type: "chunk" as const,
    fileName,
    modules: { [module]: {} },
    imports,
  });
  const handler = hook.handler as (
    html: string,
    context: unknown,
  ) => Array<{ children: string; injectTo: string }>;
  const tags = handler("", {
    bundle: {
      "workspace.js": chunk(
        "workspace.js",
        "/app/src/views/SplitWorkspaceRoute.tsx",
        ["shared.js"],
      ),
      "thread.js": chunk(
        "thread.js",
        "/app/src/views/thread-detail/ThreadDetailView.tsx",
        ["shared.js"],
      ),
      "terminal.js": chunk(
        "terminal.js",
        "/node_modules/@xterm/xterm/lib/xterm.mjs",
        ["shared.js"],
      ),
      "webgl.js": chunk(
        "webgl.js",
        "/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs",
      ),
      "panel.js": chunk(
        "panel.js",
        "/app/src/components/thread/terminal/ThreadTerminalPanel.tsx",
      ),
      "terminal-view.js": chunk(
        "terminal-view.js",
        "/node_modules/@xterm/xterm/css/xterm.css",
      ),
      "shared.js": chunk("shared.js", "/app/shared.ts"),
      "other.js": chunk("other.js", "/app/settings.ts"),
    },
  });
  const links: Array<{ href: string; rel: string; fetchPriority: string }> = [];
  const order: string[] = [];
  const timer = vi.fn();
  let fallback = () => {};
  const setTimeout = vi.fn((callback: () => void, _ms: number) => {
    fallback = callback;
    return 1;
  });
  let resolve: (response: unknown) => void = () => {};
  const fetch = vi.fn(() => {
    order.push("lookup");
    return new Promise((r) => {
      resolve = r;
    });
  });
  const document = {
    readyState: "loading",
    getElementById: () => null,
    documentElement: {},
    addEventListener: vi.fn(),
    createElement: () => ({}),
    head: {
      append: (link: { href: string; rel: string; fetchPriority: string }) => {
        order.push(link.href);
        links.push(link);
      },
    },
  };
  runInNewContext(tags[0]!.children, {
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document,
    location: { pathname },
    fetch,
    setTimeout,
    clearTimeout: timer,
  });
  return {
    links,
    fetch,
    tags,
    order,
    setTimeout,
    timer,
    fallback: () => fallback(),
    respond: async () => {
      resolve({
        ok,
        json: async () => view,
        clone: () => ({ json: async () => view }),
      });
      await new Promise((r) => globalThis.setTimeout(r, 0));
    },
  };
}

it.each(["/threads/thr_abc", "/projects/proj_a/threads/thr_abc/"])(
  "fetches the route before shell execution on %s and native assets after identity lookup",
  async (path) => {
    const state = bootstrap(path, { threadId: "thr_abc", providerId: "codex" });
    expect(state.tags[0]!.injectTo).toBe("head-prepend");
    expect(state.tags[1]).toMatchObject({
      injectTo: "head-prepend",
      attrs: { id: "bb-initial-terminal-connect" },
      children:
        'if(globalThis.__bbInitialNativeTerminalRequest)import("/assets/initial-terminal-connect.js")',
    });
    expect(state.links.map((link) => link.href)).toEqual([
      "/workspace.js",
      "/shared.js",
      "/thread.js",
    ]);
    expect(state.fetch).toHaveBeenCalledWith(
      "/api/v1/threads/thr_abc/native-terminal",
      { priority: "high" },
    );
    expect(state.order).toEqual([
      "lookup",
      "/workspace.js",
      "/shared.js",
      "/thread.js",
    ]);
    await state.respond();
    expect(state.fetch).toHaveBeenCalledWith("/api/v1/threads/thr_abc", {
      priority: "high",
    });
    expect(state.links.map((link) => link.href)).toEqual([
      "/workspace.js",
      "/shared.js",
      "/thread.js",
      "/terminal.js",
      "/webgl.js",
      "/panel.js",
    ]);
    expect(state.links.every((link) => link.rel === "modulepreload")).toBe(
      true,
    );
    expect(state.links.every((link) => link.fetchPriority === "auto")).toBe(
      true,
    );
    expect(state.timer).toHaveBeenCalledWith(1);
  },
);

it.each(["/", "/settings", "/threads", "/threads/a/messages", "/projects/p"])(
  "leaves unrelated route %s untouched",
  (path) => {
    const state = bootstrap(path, null);
    expect(state.links).toEqual([]);
    expect(state.fetch).not.toHaveBeenCalled();
  },
);

it.each([null, { threadId: "other", providerId: "codex" }, {}, "native"])(
  "does not fetch terminal assets for chat or malformed metadata %j",
  async (view) => {
    const state = bootstrap("/threads/thr_abc", view);
    await state.respond();
    expect(state.links.map((link) => link.href)).toEqual([
      "/workspace.js",
      "/shared.js",
      "/thread.js",
    ]);
    expect(state.timer).toHaveBeenCalledWith(1);
  },
);

it("does not fetch terminal assets on HTTP failure", async () => {
  const state = bootstrap(
    "/threads/thr_abc",
    { threadId: "thr_abc", providerId: "codex" },
    false,
  );
  await state.respond();
  expect(state.links).toHaveLength(3);
});

it("starts only terminal runtimes at low priority after 50ms and deduplicates on native confirmation", async () => {
  const state = bootstrap("/threads/thr_abc", {
    threadId: "thr_abc",
    providerId: "codex",
  });
  expect(state.setTimeout).toHaveBeenCalledWith(expect.any(Function), 50);
  state.fallback();
  expect(state.links.map((link) => link.href)).toEqual([
    "/workspace.js",
    "/shared.js",
    "/thread.js",
    "/terminal.js",
    "/webgl.js",
  ]);
  expect(state.links.slice(3).map((link) => link.fetchPriority)).toEqual([
    "low",
    "low",
  ]);
  await state.respond();
  expect(state.links.map((link) => link.href)).toEqual([
    "/workspace.js",
    "/shared.js",
    "/thread.js",
    "/terminal.js",
    "/webgl.js",
    "/panel.js",
  ]);
  expect(state.links.at(-1)?.fetchPriority).toBe("auto");
});

it.each([false, true])(
  "evaluates route and panel entries while DOMContentLoaded is blocked (root initially present: %s)",
  (rootInitiallyPresent) => {
    const state = bootstrap("/threads/thr_abc", null);
    const script = `
    import { runInNewContext } from "node:vm";
    const imports = [], listeners = [], marks = [], observers = [];
    let rootExists = ${rootInitiallyPresent};
    const document = { readyState: "loading", documentElement: {}, getElementById: () => rootExists ? {} : null, addEventListener: (_name, fn) => listeners.push(fn), createElement: () => ({}), head: { append() {} } };
    class MutationObserver { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} }
    const context = { URL, document, MutationObserver, location: { pathname: "/threads/thr_abc", href: "http://localhost/threads/thr_abc" }, performance: { now: () => 20, mark: (...args) => marks.push(args), getEntriesByName: () => [{ responseEnd: 10 }] }, fetch: async () => ({ ok: true, clone: () => ({ json: async () => ({ threadId: "thr_abc", providerId: "codex" }) }) }), setTimeout: () => 1, clearTimeout() {} };
    runInNewContext(${JSON.stringify(state.tags[0]!.children)}, context, { importModuleDynamically: (path) => { imports.push(path); return import("node:path") } });
    await new Promise(setImmediate);
    if (!rootExists && imports.length !== 0) throw new Error("Evaluated before root HTML existed");
    rootExists = true;
    observers.forEach(fn => fn());
    await new Promise(setImmediate);
    console.log(JSON.stringify({ imports, marks }));
  `;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--experimental-vm-modules", "--input-type=module", "-"],
        { input: script, encoding: "utf8" },
      ),
    );
    expect(result.imports).toEqual([
      "/workspace.js",
      "/thread.js",
      "/panel.js",
    ]);
    expect(result.marks).toContainEqual([
      "terminal-head-thread-import-end",
      { detail: { elapsed: 0, lastResponseEnd: 10, resources: 3 } },
    ]);
  },
);
