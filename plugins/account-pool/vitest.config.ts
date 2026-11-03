import { defineConfig } from "vitest/config";

const exclude = ["dist/**", "node_modules/**"];
const deletionResidual = "src/thread-tokens-suspend.test.ts";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "bb-plugin-account-pool",
          include: ["**/*.test.{ts,tsx}"],
          exclude: [...exclude, deletionResidual],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "bb-plugin-account-pool:deletion-residual",
          include: [deletionResidual],
          exclude,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
