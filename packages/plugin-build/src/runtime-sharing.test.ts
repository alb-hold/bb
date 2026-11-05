import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import {
  canShareRuntimeVersion,
  runtimeShimPlugin,
} from "./build-plugin-app.js";

const appRoot = new URL("../../../apps/app/", import.meta.url).pathname;
const appRequire = createRequire(join(appRoot, "package.json"));
const host = globalThis as typeof globalThis & { __bbPluginRuntime?: unknown };
const original = host.__bbPluginRuntime;
const directories: string[] = [];
afterEach(async () => {
  host.__bbPluginRuntime = original;
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it("keeps Zod bundled and renders a shimmed Radix popover with shared checkbox parts", async () => {
  const zod = appRequire("zod");
  const react = appRequire("react");
  host.__bbPluginRuntime = {
    zod,
    react,
    radixPopover: appRequire("@radix-ui/react-popover"),
    radixSlot: appRequire("@radix-ui/react-slot"),
    radixCheckbox: appRequire("@radix-ui/react-checkbox"),
  };
  const result = await build({
    stdin: {
      resolveDir: appRoot,
      contents: `
      import { z, ZodError } from "zod";
      import * as React from "react";
      import { Root, Trigger } from "@radix-ui/react-popover";
      import { Slot } from "@radix-ui/react-slot";
      export { Root as CheckboxRoot, Indicator as CheckboxIndicator } from "@radix-ui/react-checkbox";
      export const schema = z.string();
      export const accepts = value => value instanceof z.ZodString;
      export const isError = error => error instanceof ZodError;
      export const view = React.createElement(Root, null, React.createElement(Trigger, { asChild: true }, React.createElement(Slot, null, React.createElement("button", null, "Open"))));
    `,
    },
    bundle: true,
    format: "cjs",
    platform: "browser",
    write: false,
    metafile: true,
    plugins: [runtimeShimPlugin()],
  });
  expect(
    Object.keys(result.metafile!.inputs).some((path) =>
      path.includes("node_modules/zod/"),
    ),
  ).toBe(true);
  const exports = {};
  const plugin = new Function(
    "exports",
    "module",
    `${result.outputFiles[0]!.text}; return module.exports;`,
  )(exports, { exports });
  expect(plugin.schema).toBeInstanceOf(zod.ZodString);
  expect(plugin.accepts(zod.z.string())).toBe(true);
  const hostError = zod.z.string().safeParse(1).error;
  expect(plugin.isError(hostError)).toBe(true);
  expect(plugin.schema.safeParse(1).error).toBeInstanceOf(zod.ZodError);
  expect(plugin.schema.parse("hello")).toBe("hello");
  expect(plugin.CheckboxRoot).toBe(appRequire("@radix-ui/react-checkbox").Root);
  expect(plugin.CheckboxIndicator).toBe(
    appRequire("@radix-ui/react-checkbox").Indicator,
  );
  host.__bbPluginRuntime = {};
  expect(() =>
    new Function("exports", "module", result.outputFiles[0]!.text)(
      {},
      { exports: {} },
    ),
  ).toThrow('Cannot load "react"');
  host.__bbPluginRuntime = {
    zod,
    react,
    radixPopover: appRequire("@radix-ui/react-popover"),
    radixSlot: appRequire("@radix-ui/react-slot"),
    radixCheckbox: appRequire("@radix-ui/react-checkbox"),
  };
  expect(appRequire("react-dom/server").renderToString(plugin.view)).toContain(
    'aria-haspopup="dialog"',
  );
});

it.each(["3.25.0", "0.0.0", "1.999.0"])(
  "bundles incompatible Radix %s and records the fallback",
  async (version) => {
    const dir = await mkdtemp(join(tmpdir(), "bb-runtime-version-"));
    directories.push(dir);
    const pkgDir = join(dir, "node_modules/@radix-ui/react-slot");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@radix-ui/react-slot",
        version,
        main: "index.js",
      }),
    );
    await writeFile(
      join(pkgDir, "index.js"),
      'export const Slot = "plugin-owned-slot";',
    );
    const result = await build({
      stdin: {
        resolveDir: dir,
        contents: 'export { Slot } from "@radix-ui/react-slot";',
      },
      bundle: true,
      format: "esm",
      write: false,
      logLevel: "silent",
      plugins: [runtimeShimPlugin()],
    });
    expect(result.outputFiles[0]!.text).toContain("plugin-owned-slot");
    expect(result.outputFiles[0]!.text).not.toContain("__bbPluginRuntime");
    expect(result.warnings[0]!.text).toContain(
      `Bundling @radix-ui/react-slot@${version}: host runtime provides 1.`,
    );
  },
);

it.each([
  ["@radix-ui/react-slot", "Slot", "radixSlot"],
  ["@radix-ui/react-checkbox", "Root", "radixCheckbox"],
  ["@radix-ui/react-compose-refs", "composeRefs", "radixComposeRefs"],
])("shares unresolved %s from the host", async (specifier, name, slot) => {
  const dir = await mkdtemp(join(tmpdir(), "bb-runtime-missing-"));
  directories.push(dir);
  await expect(
    build({
      stdin: {
        resolveDir: dir,
        contents: `export { ${name} } from "${specifier}";`,
      },
      bundle: true,
      write: false,
      logLevel: "silent",
    }),
  ).rejects.toThrow(`Could not resolve "${specifier}"`);
  const module = appRequire(specifier!);
  host.__bbPluginRuntime = { [slot!]: module };
  const result = await build({
    stdin: {
      resolveDir: dir,
      contents: `export { ${name} } from "${specifier}";`,
    },
    bundle: true,
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [runtimeShimPlugin()],
  });
  expect(result.errors).toEqual([]);
  const exports = {};
  const plugin = new Function(
    "exports",
    "module",
    `${result.outputFiles[0]!.text};return module.exports;`,
  )(exports, { exports });
  expect(plugin[name!]).toBe(module[name!]);
});

it("keeps unresolved Zod as a build error before admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-zod-missing-"));
  directories.push(dir);
  await expect(
    build({
      stdin: {
        resolveDir: dir,
        contents: 'import { z } from "zod"; export const schema = z.string();',
      },
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [runtimeShimPlugin()],
    }),
  ).rejects.toThrow('Could not resolve "zod"');
});

it.each([
  ["3.25.0", "3.22.0", false],
  ["4.4.0", "4.3.6", false],
  ["4.3.7", "4.3.6", false],
  ["4.3.6", "4.3.6", true],
  ["4.2.0", "4.3.6", true],
  ["3.25.0", "4.3.6", false],
  ["4.3.6-beta.1", "4.3.6", false],
  ["4.3.6", undefined, false],
  [null, "4.3.6", false],
] as const)("checks plugin %s against host %s", (plugin, host, expected) => {
  expect(canShareRuntimeVersion(plugin, host)).toBe(expected);
});
