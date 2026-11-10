import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

const hasAppSources = existsSync(
  new URL("../../apps/app/src/app.css", import.meta.url),
);

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-thread-list",
    testTimeout: 15_000,
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: [
      "node_modules/**",
      ...(hasAppSources ? [] : ["app/rows/compactChrome.layout.test.ts"]),
    ],
  },
});
