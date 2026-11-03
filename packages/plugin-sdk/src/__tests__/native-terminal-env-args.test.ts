import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { experimental_nativeTerminalEnvArgs } from "../host.js";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, default: { ...original } };
});

const declaration = {
  required: ["ROUTED"],
  args: ["provider=pooled"],
  experimental_filterConfig: {
    root: { env: "TEST_CONFIG_HOME", home: ".vendor" },
    file: "config.toml",
    setting: "shell_environment_policy",
    flag: "-c",
    exclude: ["CODEX_*POOL*", "BB_ACCOUNT_POOL_*"],
  },
};
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(content?: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bb-native-filter-"));
  directories.push(directory);
  const file = path.join(directory, "config.toml");
  if (content !== undefined) writeFileSync(file, content);
  return {
    file,
    env: {
      ROUTED: "yes",
      TEST_CONFIG_HOME: directory,
      CODEX_POOL_AUTH_TOKEN: "in-memory-only",
    },
  };
}
function visible(env: Readonly<Record<string, string>>) {
  const args = experimental_nativeTerminalEnvArgs(declaration, env);
  const value = args.find((arg) =>
    arg.startsWith("shell_environment_policy.filters="),
  );
  expect(value).toBeDefined();
  const filters = z
    .object({
      shell_environment_policy: z.object({
        filters: z.record(z.string(), z.enum(["include", "exclude"])),
      }),
    })
    .parse(parse(value ?? "")).shell_environment_policy.filters;
  const matches = (pattern: string, name: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
        .replace(/\*/gu, ".*")
        .replace(/\?/gu, ".")}$`,
      "iu",
    ).test(name);
  const includes = Object.entries(filters).filter(
    ([, action]) => action === "include",
  );
  const excludes = Object.entries(filters).filter(
    ([, action]) => action === "exclude",
  );
  return Object.keys(env).filter(
    (name) =>
      !excludes.some(([pattern]) => matches(pattern, name)) &&
      (includes.length === 0 ||
        includes.some(([pattern]) => matches(pattern, name))),
  );
}
describe("native host filter configuration", () => {
  it("preserves legacy exclusions and keeps request credentials in the launch environment", () => {
    const { file, env } = fixture(
      '[shell_environment_policy]\nexclude=["P7_USER_EXCLUDED"]\n',
    );
    expect(
      visible({
        ...env,
        P7_USER_EXCLUDED: "hidden",
        PATH: "preserved",
        BB_ACCOUNT_POOL_PARENT_TOKEN: "memory",
      }),
    ).toContain("PATH");
    expect(visible({ ...env, P7_USER_EXCLUDED: "hidden" })).not.toContain(
      "P7_USER_EXCLUDED",
    );
    expect(visible(env)).not.toContain("CODEX_POOL_AUTH_TOKEN");
    expect(env.CODEX_POOL_AUTH_TOKEN).toBe("in-memory-only");
    expect(readFileSync(file, "utf8")).toBe(
      '[shell_environment_policy]\nexclude=["P7_USER_EXCLUDED"]\n',
    );
  });
  it("preserves an include_only allowlist and its exclusions", () => {
    const { env } = fixture(
      '[shell_environment_policy]\ninclude_only=["PATH","P7_ALLOWED"]\nexclude=["P7_DENIED"]\n',
    );
    expect(
      visible({
        ...env,
        PATH: "present",
        P7_ALLOWED: "present",
        P7_DENIED: "hidden",
        P7_OTHER: "hidden",
      }).sort(),
    ).toEqual(["P7_ALLOWED", "PATH"]);
  });
  it("preserves canonical filters and dotted patterns", () => {
    const { env } = fixture(
      '[shell_environment_policy.filters]\n"P7.*"="exclude"\n',
    );
    expect(
      visible({ ...env, "P7.SECRET": "hidden", PATH: "present" }),
    ).not.toContain("P7.SECRET");
  });
  it("adds only pool exclusions when no config exists", () => {
    const { env } = fixture();
    expect(visible({ ...env, PATH: "present" })).toContain("PATH");
    expect(visible(env)).not.toContain("CODEX_POOL_AUTH_TOKEN");
  });
  it.each(["system", "managed"])(
    "refuses a policy in the %s layer and leaves unpooled launches untouched",
    (layer) => {
      const { file, env } = fixture();
      const layerFile = path.join(path.dirname(file), `${layer}.toml`);
      const recipe = {
        ...declaration,
        experimental_filterConfig: {
          ...declaration.experimental_filterConfig,
          policyFiles: [layerFile],
        },
      };
      writeFileSync(layerFile, 'model="fictional"\n');
      expect(experimental_nativeTerminalEnvArgs(recipe, env)).toContain(
        "provider=pooled",
      );
      writeFileSync(
        layerFile,
        '[shell_environment_policy]\nexclude=["PRIVATE_PATTERN"]\n',
      );
      expect(() => experimental_nativeTerminalEnvArgs(recipe, env)).toThrow(
        layerFile,
      );
      expect(() => experimental_nativeTerminalEnvArgs(recipe, env)).toThrow(
        "Move the policy",
      );
      expect(
        experimental_nativeTerminalEnvArgs(recipe, { ...env, ROUTED: "" }),
      ).toEqual([]);
    },
  );
  it("checks project ancestors against the launch workspace", () => {
    const { file, env } = fixture();
    const directory = path.dirname(file);
    const cwd = path.join(directory, "workspace", "child");
    const layerFile = path.join(
      directory,
      "workspace",
      ".vendor",
      "config.toml",
    );
    mkdirSync(path.dirname(layerFile), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const recipe = {
      ...declaration,
      experimental_filterConfig: {
        ...declaration.experimental_filterConfig,
        ancestorFile: ".vendor/config.toml",
      },
    };
    writeFileSync(layerFile, 'model="fictional"\n');
    expect(experimental_nativeTerminalEnvArgs(recipe, env, cwd)).toContain(
      "provider=pooled",
    );
    writeFileSync(
      layerFile,
      '[shell_environment_policy]\ninclude_only=["PATH"]\n',
    );
    expect(() => experimental_nativeTerminalEnvArgs(recipe, env, cwd)).toThrow(
      layerFile,
    );
    expect(
      experimental_nativeTerminalEnvArgs(recipe, { ...env, ROUTED: "" }, cwd),
    ).toEqual([]);
  });
  it.each(["system", "user"])(
    "allows absent macOS %s managed preferences and refuses their presence without reading them",
    (layer) => {
      vi.spyOn(os, "platform").mockReturnValue("darwin");
      const { file, env } = fixture();
      const layerFile = path.join(path.dirname(file), `${layer}.plist`);
      const recipe = {
        ...declaration,
        experimental_filterConfig: {
          ...declaration.experimental_filterConfig,
          presenceFiles: { darwin: [layerFile] },
        },
      };
      expect(experimental_nativeTerminalEnvArgs(recipe, env)).toContain(
        "provider=pooled",
      );
      writeFileSync(layerFile, "Not TOML: do not read this value");
      expect(() => experimental_nativeTerminalEnvArgs(recipe, env)).toThrow(
        layerFile,
      );
      expect(
        experimental_nativeTerminalEnvArgs(recipe, { ...env, ROUTED: "" }),
      ).toEqual([]);
    },
  );
  it("refuses unsupported Windows pooled launches only", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const { env } = fixture();
    const recipe = {
      ...declaration,
      experimental_filterConfig: {
        ...declaration.experimental_filterConfig,
        unsupportedPlatforms: ["win32" as const],
      },
    };
    expect(() => experimental_nativeTerminalEnvArgs(recipe, env)).toThrow(
      "Pooled launches on win32 are unsupported",
    );
    expect(
      experimental_nativeTerminalEnvArgs(recipe, { ...env, ROUTED: "" }),
    ).toEqual([]);
  });
  it.each([
    'secret-value = "private-value\n',
    "[shell_environment_policy]\nexclude=123\n",
    '[shell_environment_policy]\ninclude_only=["CODEX_*POOL*"]\n',
    'profile="legacy"\n',
    '[shell_environment_policy.set]\nCODEX_POOL_AUTH_TOKEN="private-value"\n',
    '[shell_environment_policy]\nexclude=["A"]\n[ shell_environment_policy.filters ]\nB="exclude"\n',
  ])(
    "refuses untranslatable pooled config without disclosing its values",
    (content) => {
      const { env } = fixture(content);
      expect(() =>
        experimental_nativeTerminalEnvArgs(declaration, env),
      ).toThrow("Cannot safely translate shell_environment_policy");
      try {
        experimental_nativeTerminalEnvArgs(declaration, env);
      } catch (error) {
        expect(String(error)).not.toContain("private-value");
      }
      expect(
        experimental_nativeTerminalEnvArgs(declaration, { ...env, ROUTED: "" }),
      ).toEqual([]);
    },
  );
});
