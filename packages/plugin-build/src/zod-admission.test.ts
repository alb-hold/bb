import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHostZodNames } from "../scripts/generate-zod-runtime.mjs";
import { zodUsageRejection, pluginZodAdmission } from "./zod-admission.js";
import { build, transform } from "esbuild";
import { buildPluginApp, runtimeShimPlugin } from "./build-plugin-app.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";
import { createRequire } from "node:module";

const allowed = new Set(["string", "object", "number"]);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it.each([
  ['import { z } from "zod"; z.string().parse("x");', null],
  ['import * as schemas from "zod"; schemas.object({});', null],
  ['import { string as s } from "zod"; s();', null],
  ['import { z } from "zod"; z.email();', "unsupported export email"],
  ['import { z } from "zod"; z[key]();', "namespace escape or computed"],
  ['import { z } from "zod"; consume(z);', "namespace escape"],
  ['import { z } from "zod"; const stored = z;', "namespace escape"],
  ['import { z } from "zod"; typeof z;', "namespace escape"],
  ['import { z } from "zod"; const { object } = z;', "namespace escape"],
  ['import zod from "zod"; zod.string();', null],
  [
    'import { z } from "zod"; z.string(); const label = "` Function eval";',
    null,
  ],
  ['import { z } from "zod"; const label = `${z}`;', "interpolation"],
  [
    'import { z } from "zod"; if (error instanceof z.ZodError) error.issues;',
    "unsupported export ZodError",
  ],
  ['import { z } from "zod"; const copy = {...z};', "namespace escape"],
  ['import { z } from "zod"; export { z };', "namespace escape"],
  ['export * from "zod";', "re-export"],
  ['import("zod");', "dynamic"],
  ['import { z } from "zod/mini";', "unsupported subpath"],
])("conservatively admits %s", async (source, expected) => {
  const reason = await zodUsageRejection(source!, allowed);
  if (expected === null) expect(reason).toBeNull();
  else expect(reason).toContain(expected);
});

it("updates the generated subset when only host source usage changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "host-zod-"));
  dirs.push(dir);
  const entry = join(dir, "main.ts"),
    child = join(dir, "child.ts");
  await writeFile(entry, 'import "./child"; import type { z } from "zod";');
  await writeFile(
    child,
    'import {z} from "zod"; export const value=z.string();',
  );
  const resolveImport = async (specifier: string) =>
    specifier === "./child" ? child : null;
  expect(await collectHostZodNames(entry, resolveImport)).toEqual(["string"]);
  await writeFile(
    child,
    'import {z} from "zod"; export const value=z.number();',
  );
  expect(await collectHostZodNames(entry, resolveImport)).toEqual(["number"]);
  await writeFile(
    child,
    'import {z} from "zod"; export const value=z.iso.datetime();',
  );
  expect(await collectHostZodNames(entry, resolveImport)).toEqual([]);
});

it.each([false, true])(
  "records whole-plugin Zod admission in the built artifact, unsupported=%s",
  async (unsupported) => {
    const appRoot = new URL("../../../apps/app/", import.meta.url).pathname;
    const dir = await mkdtemp(join(appRoot, ".zod-admission-test-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-zod-fixture",
        version: "0.0.0",
        bb: {
          name: "Zod fixture",
          description: "Runtime admission",
          branding: { icon: "Zap" },
          server: "./server.ts",
          app: "./app.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      "export default function plugin() {}",
    );
    await writeFile(
      join(dir, "app.ts"),
      `import {z, type ZodType} from "zod"; import type { ZodError } from "zod"; export const schema=z.${unsupported ? "email" : "string"}(); type Value = z.infer<typeof schema>; type Schema = ZodType; type Error = ZodError; export const label = \`schema-\${schema.description}\`;`,
    );
    const output = await buildPluginApp(
      dir,
      "0.9.0-test",
      await resolvePluginBuildToolchain(join(tmpdir(), "bb-toolchain-unused")),
      { minify: true, hostProvidedZod: true },
    );
    const meta = JSON.parse(await readFile(output.metaPath, "utf8"));
    expect(meta.runtimeSlots.includes("zod")).toBe(!unsupported);
    expect(
      output.migrationWarnings.some((warning) =>
        warning.includes("unsupported export email"),
      ),
    ).toBe(unsupported);
    const hostZod = createRequire(join(appRoot, "package.json"))("zod");
    const runtimeHost = globalThis as typeof globalThis & {
      __bbPluginRuntime?: unknown;
    };
    const original = runtimeHost.__bbPluginRuntime;
    runtimeHost.__bbPluginRuntime = {
      zod: { z: { string: hostZod.z.string } },
    };
    try {
      const code = await transform(await readFile(output.jsPath, "utf8"), {
        format: "cjs",
      });
      const exports = {};
      const plugin = new Function(
        "exports",
        "module",
        `${code.code}; return module.exports;`,
      )(exports, { exports });
      expect(plugin.schema.safeParse(42).success).toBe(false);
      if (!unsupported)
        expect(plugin.schema.constructor).toBe(hostZod.ZodString);
    } finally {
      runtimeHost.__bbPluginRuntime = original;
    }
  },
);

it("falls back for the whole plugin when a transitive source has one unsupported use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plugin-zod-"));
  dirs.push(dir);
  const appRoot = new URL("../../../apps/app/", import.meta.url).pathname;
  const require = createRequire(join(appRoot, "package.json"));
  await writeFile(
    join(dir, "main.js"),
    'import { z } from "zod"; import "./child.js"; export const schema=z.string();',
  );
  await writeFile(
    join(dir, "child.js"),
    'import { z } from "zod"; globalThis.schema=z.email();',
  );
  const result = await build({
    entryPoints: [join(dir, "main.js")],
    absWorkingDir: dir,
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    alias: { zod: require.resolve("zod") },
    plugins: [runtimeShimPlugin()],
  });
  const admission = await pluginZodAdmission(
    result.metafile!,
    dir,
    transform,
    async () => true,
  );
  expect(admission.shared).toBe(false);
  expect(admission.reason).toContain("unsupported export email");
  expect(result.outputFiles[0]!.text).not.toContain("runtime.zod");
  const incompatible = await pluginZodAdmission(
    result.metafile!,
    dir,
    transform,
    async () => false,
  );
  expect(incompatible).toEqual({
    shared: false,
    reason: "incompatible, newer or unknown Zod version",
  });
});

it.each(["z.email()", "consume(z)"])(
  "rejects a bundled npm dependency's unsupported Zod use: %s",
  async (use) => {
    const appRoot = new URL("../../../apps/app/", import.meta.url).pathname;
    const dir = await mkdtemp(join(appRoot, ".zod-npm-test-"));
    dirs.push(dir);
    const dependency = join(dir, "node_modules/schema-helper");
    await mkdir(dependency, { recursive: true });
    const zod = join(dir, "node_modules/zod");
    await mkdir(zod, { recursive: true });
    await writeFile(
      join(zod, "package.json"),
      JSON.stringify({ name: "zod", version: "4.6.5", main: "index.js" }),
    );
    await writeFile(
      join(zod, "index.js"),
      "export const z = { string: () => ({}), email: () => ({}) };",
    );
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "schema-helper",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    await writeFile(
      join(dependency, "index.js"),
      `import {z} from "zod"; globalThis.helper = ${use};`,
    );
    await writeFile(
      join(dir, "main.ts"),
      'import {z} from "zod"; import "schema-helper"; export const schema = z.string();',
    );
    const result = await build({
      entryPoints: [join(dir, "main.ts")],
      absWorkingDir: dir,
      bundle: true,
      write: false,
      metafile: true,
      platform: "browser",
      plugins: [runtimeShimPlugin()],
    });
    const admission = await pluginZodAdmission(
      result.metafile!,
      dir,
      transform,
      async () => true,
    );
    expect(admission.shared).toBe(false);
    expect(admission.reason).toContain("schema-helper/index.js");
    expect(admission.reason).toContain(
      use === "z.email()" ? "unsupported export email" : "namespace escape",
    );
  },
);

it("evaluates a shimmed plugin with the host schema constructor and host-recognised thrown errors", async () => {
  const appRoot = new URL("../../../apps/app/", import.meta.url).pathname;
  const require = createRequire(join(appRoot, "package.json"));
  const hostZod = require("zod");
  const runtimeHost = globalThis as typeof globalThis & {
    __bbPluginRuntime?: unknown;
  };
  const original = runtimeHost.__bbPluginRuntime;
  runtimeHost.__bbPluginRuntime = { zod: { z: { string: hostZod.z.string } } };
  try {
    const result = await build({
      stdin: {
        resolveDir: appRoot,
        contents:
          'import {z} from "zod"; export const schema=z.string(); export const fail=()=>schema.parse(42);',
      },
      bundle: true,
      write: false,
      metafile: true,
      platform: "browser",
      format: "cjs",
      plugins: [runtimeShimPlugin(undefined, true)],
    });
    expect(
      Object.keys(result.metafile!.inputs).some((path) =>
        path.includes("/node_modules/zod/"),
      ),
    ).toBe(false);
    const exports = {};
    const plugin = new Function(
      "exports",
      "module",
      `${result.outputFiles[0]!.text};return module.exports;`,
    )(exports, { exports });
    expect(plugin.schema.constructor).toBe(hostZod.ZodString);
    expect(plugin.fail).toThrow(hostZod.ZodError);
    expect(plugin.schema.parse("hello")).toBe("hello");
  } finally {
    runtimeHost.__bbPluginRuntime = original;
  }
});
