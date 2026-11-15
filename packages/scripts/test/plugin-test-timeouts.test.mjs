import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MINIMUM_TIMEOUT_MS = 20_000;
const VITEST_DEFAULTS = { testTimeout: 5_000, hookTimeout: 10_000 };
const ALLOWED_BELOW_MINIMUM = new Map();
const CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
];
const PROJECT_CONFIG_FILES = ["vitest.config", "vite.config"].flatMap((name) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
    (extension) => `${name}.${extension}`,
  ),
);
const UNRESOLVED = { testTimeout: null, hookTimeout: null };
const PROJECT_CONFIG_FILE =
  /(?:^|[./-])vite(?:st)?(?:\.[\w-]+)*\.config(?:\.[\w-]+)*\.[cm]?[jt]s$/u;

const configs = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    CONFIG_FILES.map((file) => join(ROOT, "plugins", entry.name, file)),
  )
  .filter((path) => existsSync(path));

async function loadConfig(path) {
  const loaded = (await import(pathToFileURL(path).href)).default;
  return typeof loaded === "function"
    ? await loaded({ command: "serve", mode: "test" })
    : loaded;
}

function ownTimeouts(config, inherited) {
  return {
    testTimeout: config.test?.testTimeout ?? inherited.testTimeout,
    hookTimeout: config.test?.hookTimeout ?? inherited.hookTimeout,
  };
}

function projectConfigIn(directory) {
  const file = PROJECT_CONFIG_FILES.map((name) => join(directory, name)).find(
    (path) => existsSync(path),
  );
  return file === undefined ? { path: directory, config: {} } : { path: file };
}

async function expandProjects(configPath, patterns) {
  const directory = dirname(configPath);
  const included = new Set();
  const unmatched = [];
  for (const pattern of patterns.filter((entry) => !entry.startsWith("!"))) {
    const matches = globSync(pattern, { cwd: directory });
    if (matches.length === 0) unmatched.push(pattern);
    for (const match of matches) included.add(resolve(directory, match));
  }
  for (const pattern of patterns.filter((entry) => entry.startsWith("!")))
    for (const match of globSync(pattern.slice(1), { cwd: directory }))
      included.delete(resolve(directory, match));
  const matched = [];
  for (const path of [...included].sort()) {
    if (statSync(path).isDirectory()) {
      const project = projectConfigIn(path);
      matched.push({
        path: project.path,
        config: project.config ?? (await loadConfig(project.path)),
      });
      continue;
    }
    matched.push(
      PROJECT_CONFIG_FILE.test(basename(path))
        ? { path, config: await loadConfig(path) }
        : { path, config: null },
    );
  }
  return { matched, unmatched };
}

async function resolvedTimeouts(path, config, expand = expandProjects) {
  const inRepository = relative(ROOT, path);
  const name = inRepository.startsWith("..") ? path : inRepository;
  if (config === null) return [{ name, ...UNRESOLVED }];
  const root = ownTimeouts(config, VITEST_DEFAULTS);
  const projects = config.test?.projects ?? [];
  if (projects.length === 0) return [{ name, ...root }];
  const resolved = [];
  const patterns = projects.filter((project) => typeof project === "string");
  if (patterns.length > 0) {
    const { matched, unmatched } = await expand(path, patterns);
    for (const pattern of unmatched)
      resolved.push({ name: `${name} ${pattern}`, ...UNRESOLVED });
    if (matched.length === 0 && unmatched.length === 0)
      resolved.push({ name: `${name} ${patterns.join(" ")}`, ...UNRESOLVED });
    for (const project of matched)
      resolved.push(
        ...(await resolvedTimeouts(project.path, project.config, expand)),
      );
  }
  for (const project of projects.filter((entry) => typeof entry !== "string")) {
    if (typeof project !== "object" || project === null) {
      resolved.push({ name: `${name} ${String(project)}`, ...UNRESOLVED });
      continue;
    }
    const label = `${name} ${project.test?.name ?? "unnamed project"}`;
    let inherited = VITEST_DEFAULTS;
    if (project.extends === true) inherited = root;
    if (typeof project.extends === "string") {
      const parent = resolve(dirname(path), project.extends);
      inherited = existsSync(parent)
        ? ownTimeouts(await loadConfig(parent), VITEST_DEFAULTS)
        : UNRESOLVED;
    }
    resolved.push({ name: label, ...ownTimeouts(project, inherited) });
  }
  return resolved;
}

function belowMinimum(timeouts) {
  return timeouts
    .filter(({ name }) => !ALLOWED_BELOW_MINIMUM.has(name))
    .filter(
      ({ testTimeout, hookTimeout }) =>
        testTimeout === null ||
        hookTimeout === null ||
        testTimeout < MINIMUM_TIMEOUT_MS ||
        hookTimeout < MINIMUM_TIMEOUT_MS,
    );
}

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

function writeConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `export default ${JSON.stringify(config)};\n`);
  return path;
}

describe("plugin test timeouts", () => {
  it("finds every plugin's vitest config", () => {
    expect(configs.length).toBeGreaterThan(40);
  });

  it.each(configs.map((path) => relative(ROOT, path)))(
    "%s gives every test and every hook at least 20 s before vitest fails it",
    async (path) => {
      const absolute = join(ROOT, path);
      expect(
        belowMinimum(
          await resolvedTimeouts(absolute, await loadConfig(absolute)),
        ),
      ).toEqual([]);
    },
  );

  it("resolves a project's timeouts from its own config, its parent when it extends it, or vitest's defaults", async () => {
    expect(
      await resolvedTimeouts(join(ROOT, "p"), {
        test: {
          testTimeout: 20_000,
          hookTimeout: 25_000,
          projects: [
            { extends: true, test: { name: "inherits" } },
            { test: { name: "default" } },
            { test: { name: "own", testTimeout: 30_000, hookTimeout: 40_000 } },
          ],
        },
      }),
    ).toEqual([
      { name: "p inherits", testTimeout: 20_000, hookTimeout: 25_000 },
      { name: "p default", testTimeout: 5_000, hookTimeout: 10_000 },
      { name: "p own", testTimeout: 30_000, hookTimeout: 40_000 },
    ]);
    expect(await resolvedTimeouts(join(ROOT, "q"), { test: {} })).toEqual([
      { name: "q", testTimeout: 5_000, hookTimeout: 10_000 },
    ]);
  });

  it("fails a project whose tests get 20 s but whose hooks get less", async () => {
    const short = await resolvedTimeouts(join(ROOT, "p"), {
      test: { testTimeout: 20_000, hookTimeout: 5_000 },
    });
    const inherited = await resolvedTimeouts(join(ROOT, "q"), {
      test: { testTimeout: 20_000 },
    });

    expect(belowMinimum(short)).toEqual([
      { name: "p", testTimeout: 20_000, hookTimeout: 5_000 },
    ]);
    expect(belowMinimum(inherited)).toEqual([
      { name: "q", testTimeout: 20_000, hookTimeout: 10_000 },
    ]);
    expect(
      belowMinimum(
        await resolvedTimeouts(join(ROOT, "r"), {
          test: { testTimeout: 20_000, hookTimeout: 20_000 },
        }),
      ),
    ).toEqual([]);
  });

  it("resolves projects given as config files, directories and globs, with negation, from the files on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-timeouts-"));
    fixtures.push(root);
    const good = { test: { testTimeout: 20_000, hookTimeout: 20_000 } };
    const config = writeConfig(join(root, "vitest.config.mjs"), {
      test: {
        projects: [
          "packages/*",
          "!packages/ignored",
          "tools/vitest.config.mjs",
          { extends: "./base.config.mjs", test: { name: "inline" } },
        ],
      },
    });
    writeConfig(join(root, "base.config.mjs"), good);
    writeConfig(join(root, "packages/a/vitest.config.mjs"), good);
    writeConfig(join(root, "packages/short-hooks/vitest.config.mjs"), {
      test: { testTimeout: 20_000, hookTimeout: 5_000 },
    });
    mkdirSync(join(root, "packages/no-config"), { recursive: true });
    writeConfig(join(root, "packages/ignored/vitest.config.mjs"), {
      test: { testTimeout: 1 },
    });
    writeConfig(join(root, "tools/vitest.config.mjs"), good);
    writeFileSync(join(root, "packages/notes.md"), "not a project\n");

    const resolved = await resolvedTimeouts(config, await loadConfig(config));

    expect(resolved).toEqual([
      { name: join(root, "packages/a/vitest.config.mjs"), ...good.test },
      {
        name: join(root, "packages/no-config"),
        testTimeout: 5_000,
        hookTimeout: 10_000,
      },
      { name: join(root, "packages/notes.md"), ...UNRESOLVED },
      {
        name: join(root, "packages/short-hooks/vitest.config.mjs"),
        testTimeout: 20_000,
        hookTimeout: 5_000,
      },
      { name: join(root, "tools/vitest.config.mjs"), ...good.test },
      { name: `${config} inline`, ...good.test },
    ]);
    expect(belowMinimum(resolved).map(({ name }) => name)).toEqual([
      join(root, "packages/no-config"),
      join(root, "packages/notes.md"),
      join(root, "packages/short-hooks/vitest.config.mjs"),
    ]);
  });

  it("resolves a directory project from its vite.config file when it has no vitest.config, and prefers vitest.config when it has both", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-timeouts-"));
    fixtures.push(root);
    const good = { test: { testTimeout: 20_000, hookTimeout: 20_000 } };
    const config = writeConfig(join(root, "vitest.config.mjs"), {
      test: { projects: ["packages/*"] },
    });
    writeConfig(join(root, "packages/vite-only/vite.config.ts"), good);
    writeConfig(join(root, "packages/both/vite.config.mjs"), {
      test: { testTimeout: 1, hookTimeout: 1 },
    });
    writeConfig(join(root, "packages/both/vitest.config.mjs"), good);

    const resolved = await resolvedTimeouts(config, await loadConfig(config));

    expect(resolved).toEqual([
      { name: join(root, "packages/both/vitest.config.mjs"), ...good.test },
      { name: join(root, "packages/vite-only/vite.config.ts"), ...good.test },
    ]);
    expect(belowMinimum(resolved)).toEqual([]);
  });

  it("fails each project pattern that matches nothing, even when another pattern matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-timeouts-"));
    fixtures.push(root);
    const config = writeConfig(join(root, "vitest.config.mjs"), {
      test: { projects: ["packages/*", "missing/*"] },
    });
    writeConfig(join(root, "packages/a/vitest.config.mjs"), {
      test: { testTimeout: 20_000, hookTimeout: 20_000 },
    });

    expect(
      belowMinimum(await resolvedTimeouts(config, await loadConfig(config))),
    ).toEqual([{ name: `${config} missing/*`, ...UNRESOLVED }]);
  });

  it("passes when every project pattern matches, and a negation that excludes nothing is not an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-timeouts-"));
    fixtures.push(root);
    const good = { test: { testTimeout: 20_000, hookTimeout: 20_000 } };
    const config = writeConfig(join(root, "vitest.config.mjs"), {
      test: { projects: ["packages/*", "tools/*", "!packages/none"] },
    });
    writeConfig(join(root, "packages/a/vitest.config.mjs"), good);
    writeConfig(join(root, "tools/b/vitest.config.mjs"), good);

    const resolved = await resolvedTimeouts(config, await loadConfig(config));

    expect(resolved.map(({ name }) => name)).toEqual([
      join(root, "packages/a/vitest.config.mjs"),
      join(root, "tools/b/vitest.config.mjs"),
    ]);
    expect(belowMinimum(resolved)).toEqual([]);
  });

  it("fails project patterns whose negations exclude every match", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-timeouts-"));
    fixtures.push(root);
    const config = writeConfig(join(root, "vitest.config.mjs"), {
      test: { projects: ["packages/*", "!packages/*"] },
    });
    writeConfig(join(root, "packages/a/vitest.config.mjs"), {
      test: { testTimeout: 20_000, hookTimeout: 20_000 },
    });

    expect(
      belowMinimum(await resolvedTimeouts(config, await loadConfig(config))),
    ).toEqual([{ name: `${config} packages/* !packages/*`, ...UNRESOLVED }]);
  });

  it("fails a project pattern that matches nothing, and an entry it cannot read", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-timeouts-"));
    fixtures.push(root);
    const config = writeConfig(join(root, "vitest.config.mjs"), {
      test: { projects: ["missing/*"] },
    });

    expect(
      belowMinimum(await resolvedTimeouts(config, await loadConfig(config))),
    ).toEqual([{ name: `${config} missing/*`, ...UNRESOLVED }]);
    expect(
      belowMinimum(
        await resolvedTimeouts(join(ROOT, "p"), { test: { projects: [7] } }),
      ),
    ).toEqual([{ name: "p 7", ...UNRESOLVED }]);
  });
});
