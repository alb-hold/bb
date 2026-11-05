import { buildPluginApp } from "../../packages/plugin-build/src/build-plugin-app.ts";
import { resolvePluginBuildToolchain } from "../../packages/plugin-build/src/toolchain.ts";
import { resolve } from "node:path";
await buildPluginApp(
  resolve("plugins/composer"),
  "0.0.0-perf-r5",
  await resolvePluginBuildToolchain(
    resolve("packages/plugin-build/node_modules/.bb-toolchain"),
  ),
);
