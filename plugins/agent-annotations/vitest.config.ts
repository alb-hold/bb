import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    silent: "passed-only",
    name: "bb-plugin-agent-annotations",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
