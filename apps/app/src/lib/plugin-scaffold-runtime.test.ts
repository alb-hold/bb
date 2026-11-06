import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { buildPluginApp, resolvePluginBuildToolchain } from "@bb/plugin-build";
import { scaffoldPlugin } from "@bb/templates/plugin-scaffold";
import { installPluginRuntime, loadPluginFrontend } from "./plugin-frontend";

let root: string | undefined;

afterEach(async () => {
  delete (globalThis as typeof globalThis & { __bbPluginRuntime?: unknown })
    .__bbPluginRuntime;
  if (root) await rm(root, { recursive: true, force: true });
});

it("provides every runtime slot declared by the built plugin scaffold", async () => {
  root = await mkdtemp(
    join(
      fileURLToPath(new URL("../../", import.meta.url)),
      ".scaffold-runtime-",
    ),
  );
  const targetDir = join(root, "bb-plugin-scaffolded");
  await scaffoldPlugin({
    targetDir,
    packageName: "bb-plugin-scaffolded",
    bbVersion: "0.9.0",
  });
  const result = await buildPluginApp(
    targetDir,
    "0.9.0-test",
    await resolvePluginBuildToolchain(join(root, "toolchain")),
  );
  const meta = JSON.parse(await readFile(result.metaPath, "utf8")) as {
    runtimeSlots: string[];
    sdkMajor: number;
    sdkVersion: string;
  };
  expect(meta.runtimeSlots.length).toBeGreaterThan(0);
  const importModule = vi.fn(async () => {
    const runtime = installPluginRuntime();
    for (const slot of meta.runtimeSlots) {
      expect(
        runtime,
        `Host must provide scaffold runtime slot: ${slot}`,
      ).toHaveProperty(slot);
      expect(Reflect.get(runtime, slot)).toBeDefined();
    }
    return import(/* @vite-ignore */ pathToFileURL(result.jsPath).href);
  });
  const loaded = await loadPluginFrontend(
    {
      pluginId: "scaffolded",
      bundle: {
        jsUrl: pathToFileURL(result.jsPath).href,
        cssUrl: null,
        jsBytes: 1,
        hash: "scaffold-test",
        sdkMajor: meta.sdkMajor,
        sdkVersion: meta.sdkVersion,
        compatible: true,
        runtimeSlots: meta.runtimeSlots,
      },
    },
    { importModule, prefetchModule: vi.fn(), warn: vi.fn() },
  );
  expect(loaded, JSON.stringify(loaded)).toMatchObject({
    status: "loaded",
    module: { default: { __bbPluginApp: true, setup: expect.any(Function) } },
  });
  expect(importModule).toHaveBeenCalledOnce();
}, 60_000);
