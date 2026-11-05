import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  parsePluginFrontendInventory,
  type PluginFrontendInventory,
} from "@bb/domain";
import type * as Esbuild from "esbuild";
import { RUNTIME_SLOT_BY_SPECIFIER } from "./runtime-shims.mjs";
import { RUNTIME_EXPORT_MANIFEST } from "./generated/runtime-export-manifest.generated.js";

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { createHook } = require("node:async_hooks");
try {
  const context = vm.createContext({}, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  new vm.Script(workerData.bootstrap).runInContext(context, { timeout: 100 });
  let asynchronous = false;
  const hook = createHook({ init(id, type) { if (type === "PROMISE") asynchronous = true; } });
  hook.enable();
  const result = new vm.Script(workerData.source).runInContext(context, { timeout: 100 });
  hook.disable();
  parentPort.postMessage(!asynchronous && typeof result === "string" ? result : "null");
} catch { parentPort.postMessage("null"); }
`;

export function recordFrontendInventory(
  bootstrap: string,
  source: string,
): Promise<PluginFrontendInventory | null> {
  return new Promise((resolve) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { bootstrap, source },
      resourceLimits: {
        maxOldGenerationSizeMb: 48,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
    const finish = (result: PluginFrontendInventory | null) => {
      clearTimeout(timeout);
      void worker.terminate();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), 1_000);
    worker.once("message", (value: unknown) => {
      try {
        finish(
          typeof value === "string"
            ? parsePluginFrontendInventory(JSON.parse(value))
            : null,
        );
      } catch {
        finish(null);
      }
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

export async function buildFrontendInventory(args: {
  rootDir: string;
  jsPath: string;
  runtimeSlots: readonly string[];
  esbuild: Pick<typeof Esbuild, "build" | "transform">;
}): Promise<PluginFrontendInventory | null> {
  try {
    const localRequire = createRequire(join(args.rootDir, "package.json"));
    const resolvers = [localRequire, createRequire(import.meta.url)];
    try {
      resolvers.push(
        createRequire(localRequire.resolve("@bb/shared-ui/button")),
      );
    } catch {}
    const imports: string[] = [];
    const slots: string[] = [];
    for (const slot of args.runtimeSlots) {
      const specifier = Object.entries(RUNTIME_SLOT_BY_SPECIFIER).find(
        ([, value]) => value === slot,
      )?.[0];
      if (specifier === undefined) return null;
      if (
        slot === "pluginSdkApp" ||
        slot === "sharedUiIcon" ||
        slot === "questionFormHost" ||
        slot === "voiceInputTextarea"
      ) {
        const exports = RUNTIME_EXPORT_MANIFEST[specifier];
        if (exports === undefined) return null;
        slots.push(
          `${JSON.stringify(slot)}: { ${exports.map((name) => `${JSON.stringify(name)}: ${name === "definePluginApp" ? "(setup) => ({ __bbPluginApp: true, setup })" : "unavailable"}`).join(",")} }`,
        );
        continue;
      }
      let path: string | undefined;
      for (const resolver of resolvers) {
        try {
          path = resolver.resolve(specifier);
          break;
        } catch {}
      }
      if (path === undefined) return null;
      const name = `runtime${imports.length}`;
      imports.push(`import * as ${name} from ${JSON.stringify(path)};`);
      slots.push(`${JSON.stringify(slot)}: ${name}`);
    }
    const collector = createRequire(import.meta.url).resolve(
      "@get-bb/plugin-sdk/internal/plugin-app-collector",
    );
    const bootstrapBuild = args.esbuild.build({
      stdin: {
        contents: [
          `import { collectPluginAppRegistrations } from ${JSON.stringify(collector)};`,
          ...imports,
          `function unavailable() { globalThis.__inventoryUnavailable = true; throw new Error("Runtime access during frontend inventory"); }`,
          `globalThis.__bbPluginRuntime = { ${slots.join(",")} };`,
          `globalThis.__collectFrontendInventory = collectPluginAppRegistrations;`,
          `collectPluginAppRegistrations({ setup() {} });`,
        ].join("\n"),
        resolveDir: dirname(collector),
        loader: "js",
      },
      bundle: true,
      minify: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const frontendTransform = readFile(args.jsPath, "utf8").then((source) =>
      args.esbuild.transform(source, {
        format: "iife",
        minifyWhitespace: true,
        minifyIdentifiers: true,
        treeShaking: false,
        globalName: "__frontendInventoryModule",
      }),
    );
    const [bootstrap, transformed] = await Promise.all([
      bootstrapBuild,
      frontendTransform,
    ]);
    return await recordFrontendInventory(
      bootstrap.outputFiles[0]!.text,
      `
      const unavailable = (reason) => { globalThis.__inventoryUnavailable = true; throw new Error("Unavailable frontend inventory global: " + String(reason)); };
      for (const name of ["window", "document", "navigator", "location", "history", "screen", "matchMedia", "indexedDB", "console", "process", "fetch", "XMLHttpRequest", "WebSocket", "setTimeout", "setInterval", "queueMicrotask", "requestAnimationFrame", "localStorage", "sessionStorage", "Date", "Promise", "crypto", "performance"]) {
        Object.defineProperty(globalThis, name, { get() { unavailable(name); }, configurable: false });
      }
      Math.random = unavailable;
      globalThis.__inventoryUnavailable = false;
      const inventoryGlobal = globalThis;
      const readonlyGlobal = new Proxy(inventoryGlobal, {
        get(target, key) { if (!(key in target)) unavailable(key); return Reflect.get(target, key); },
        set: unavailable,
      });
      const inventoryGlobals = new Proxy(inventoryGlobal, {
        has(target, key) { if (typeof key === "symbol") return false; if (!(key in target)) unavailable(key); return true; },
        get(target, key) { if (key === Symbol.unscopables) return undefined; return key === "globalThis" ? readonlyGlobal : Reflect.get(target, key); },
      });
      with (inventoryGlobals) {
      ${transformed.code}
      const definition = __frontendInventoryModule.default;
      if (!definition || definition.__bbPluginApp !== true || typeof definition.setup !== "function" || definition.setup.constructor.name !== "Function") throw new Error("Unknown setup");
      const sections = [];
      const recorded = __collectFrontendInventory({
        ...definition,
        setup(app) {
          const settingsSection = app.slots.settingsSection;
          app.slots.settingsSection = (section) => {
            for (const key of Reflect.ownKeys(section)) {
              const descriptor = Object.getOwnPropertyDescriptor(section, key);
              if (descriptor?.get || descriptor?.set) throw new Error("Dynamic section metadata");
              if (key === "component") continue;
              if (!["id", "title", "description", "experimental_page"].includes(key) || typeof section[key] !== "string") throw new Error("Non-serializable section");
            }
            const { component, ...metadata } = section;
            sections.push(metadata);
            settingsSection(section);
          };
          const recordingApi = (target) => new Proxy(target, {
            get(target, key) {
              if (!(key in target)) unavailable(key);
              const value = Reflect.get(target, key);
              return value !== null && typeof value === "object" ? recordingApi(value) : value;
            },
            has(target, key) { if (!(key in target)) unavailable(key); return true; },
          });
          if (definition.setup(recordingApi(app)) !== undefined) throw new Error("Asynchronous setup");
        }
      });
      if (Object.entries(recorded).some(([key, value]) => key !== "settingsSections" && (!Array.isArray(value) || value.length > 0))) throw new Error("Non-settings registration");
      if (globalThis.__inventoryUnavailable) throw new Error("Unavailable inventory access");
      JSON.stringify({ version: 1, settingsSections: sections });
      }
    `,
    );
  } catch {
    return null;
  }
}
