import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../vitest.shared";
const pkgDir = new URL("../plugins/thread-list", import.meta.url).pathname;

export default defineWorkspaceTestConfig({
  root: pkgDir,
  resolve: { tsconfigPaths: true },
  test: {
    provide: { threadListPluginCss: null, threadListChromiumPath: null },
    testTimeout: 15000,
    projects: sharedWorkerProjects({
      pkgDir,
      name: "bb-plugin-thread-list:node",
      include: ["**/*.test.{ts,tsx}"],
      exclude: ["node_modules/**", "app/rows/compactChrome.layout.test.ts"],
    }),
  },
});
