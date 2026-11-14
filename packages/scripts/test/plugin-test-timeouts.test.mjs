import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MINIMUM_TEST_TIMEOUT_MS = 20_000;
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;
const ALLOWED_BELOW_MINIMUM = new Map();
const CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
];

const configs = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    CONFIG_FILES.map((file) => join("plugins", entry.name, file)),
  )
  .filter((path) => existsSync(join(ROOT, path)));

async function loadConfig(path) {
  const loaded = (await import(pathToFileURL(join(ROOT, path)).href)).default;
  return typeof loaded === "function"
    ? await loaded({ command: "serve", mode: "test" })
    : loaded;
}

function resolvedTestTimeouts(path, config) {
  const rootTimeout =
    config.test?.testTimeout ?? VITEST_DEFAULT_TEST_TIMEOUT_MS;
  const projects = config.test?.projects ?? [];
  if (projects.length === 0) return [{ name: path, testTimeout: rootTimeout }];
  return projects.map((project) => {
    if (typeof project !== "object" || project === null)
      return { name: `${path} ${String(project)}`, testTimeout: null };
    const inherited =
      project.extends === true ? rootTimeout : VITEST_DEFAULT_TEST_TIMEOUT_MS;
    return {
      name: `${path} ${project.test?.name ?? "unnamed project"}`,
      testTimeout: project.test?.testTimeout ?? inherited,
    };
  });
}

describe("plugin test timeouts", () => {
  it("finds every plugin's vitest config", () => {
    expect(configs.length).toBeGreaterThan(40);
  });

  it.each(configs)(
    "%s gives every test at least 20 s before vitest fails it",
    async (path) => {
      const tooShort = resolvedTestTimeouts(path, await loadConfig(path))
        .filter(({ name }) => !ALLOWED_BELOW_MINIMUM.has(name))
        .filter(
          ({ testTimeout }) =>
            testTimeout === null || testTimeout < MINIMUM_TEST_TIMEOUT_MS,
        );

      expect(tooShort).toEqual([]);
    },
  );

  it("resolves a project's timeout from its own config, its parent when it extends it, or vitest's default", () => {
    expect(
      resolvedTestTimeouts("p", {
        test: {
          testTimeout: 20_000,
          projects: [
            { extends: true, test: { name: "inherits" } },
            { test: { name: "default" } },
            { test: { name: "own", testTimeout: 30_000 } },
          ],
        },
      }),
    ).toEqual([
      { name: "p inherits", testTimeout: 20_000 },
      { name: "p default", testTimeout: 5_000 },
      { name: "p own", testTimeout: 30_000 },
    ]);
    expect(resolvedTestTimeouts("q", { test: {} })).toEqual([
      { name: "q", testTimeout: 5_000 },
    ]);
  });
});
