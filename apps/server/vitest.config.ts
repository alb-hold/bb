import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

const exclude = ["dist/**", "node_modules/**"];
const deletionMatrix = "test/threads/account-pool-delete-matrix-*.test.ts";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    testTimeout: 15_000,
    setupFiles: [
      "test/setup/stored-event-decode-freeze.ts",
      "test/setup/warm-test-harness.ts",
    ],
    env: {
      BB_DATA_DIR: "/tmp/bb-server-test",
      BB_SERVER_PORT: "49161",
      BB_HOST_DAEMON_PORT: "49162",
    },
    projects: [
      ...sharedWorkerProjects({
        pkgDir: __dirname,
        name: "@bb/server",
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        exclude: [...exclude, deletionMatrix],
      }).map((project) => ({
        ...project,
        test: { ...project.test, sequence: { groupOrder: 0 } },
      })),
      {
        extends: true,
        test: {
          name: "@bb/server:account-pool-delete-matrix",
          include: [deletionMatrix],
          exclude,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
