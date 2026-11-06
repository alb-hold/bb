import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared";
export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    provide: { threadListPluginCss: null, threadListChromiumPath: null },
    testTimeout: 15000,
    projects: sharedWorkerProjects({
      pkgDir: import.meta.dirname,
      name: "bb-plugin-thread-list:node",
      include: ["**/*.test.{ts,tsx}"],
      exclude: ["node_modules/**", "app/rows/compactChrome.layout.test.ts"],
    }),
  },
});
