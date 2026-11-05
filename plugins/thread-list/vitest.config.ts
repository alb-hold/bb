import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-thread-list",
    testTimeout: 15_000,
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
