import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    silent: "passed-only",
    name: "bb-plugin-bb-guide",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
