import fs from "node:fs/promises";
import path from "node:path";

const ALWAYS_OUTPUT = /(^|\/)(?:node_modules|\.turbo)(?:\/|$)|\.tsbuildinfo$/u;
const POSSIBLE_OUTPUT =
  /(^|\/)(?:dist|\.next|coverage|test-results|playwright-report)(?:\/|$)|(^|\/)src\/generated(?:\/|$)/u;

type JsonObject = Record<string, unknown>;
type Outputs = { include: string[]; exclude: string[] };

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return value as JsonObject;
}

async function config(filename: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const withoutComments = text.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu,
    (token) => (token.startsWith("/") ? " " : token),
  );
  const json = withoutComments.replace(
    /"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/gu,
    (token) => (token.startsWith(",") ? "" : token),
  );
  const parsed: unknown = JSON.parse(json);
  return object(parsed);
}

async function declaredOutputs(root: string): Promise<Outputs[] | null> {
  try {
    const rootConfig = await config(path.join(root, "turbo.json"));
    if (rootConfig === null) return [];
    const rootTasks = object(rootConfig.tasks ?? {});
    const packages = new Map<
      string,
      { directory: string; scripts: JsonObject; tasks: JsonObject }
    >();
    for await (const filename of fs.glob("**/package.json", {
      cwd: root,
      exclude: [
        "**/node_modules/**",
        "**/.git/**",
        "**/.turbo/**",
        "**/dist/**",
        "**/.next/**",
        "**/coverage/**",
        "**/src/generated/**",
      ],
    })) {
      const manifest = await config(path.join(root, filename));
      if (manifest === null) throw new Error("Package disappeared");
      const directory = path.dirname(filename);
      const local =
        directory === "."
          ? null
          : await config(path.join(root, directory, "turbo.json"));
      const name = manifest.name;
      if (typeof name !== "string") continue;
      if (packages.has(name)) throw new Error("Duplicate package name");
      packages.set(name, {
        directory,
        scripts: object(manifest.scripts ?? {}),
        tasks: local === null ? {} : object(local.tasks ?? {}),
      });
    }
    const outputs: Outputs[] = [];
    const add = (task: unknown, directory: string) => {
      const raw = object(task).outputs;
      if (raw === undefined) return;
      if (
        !Array.isArray(raw) ||
        !raw.every((item): item is string => typeof item === "string")
      )
        throw new Error("Invalid outputs");
      const patterns: Outputs = { include: [], exclude: [] };
      for (let pattern of raw) {
        const exclude = pattern.startsWith("!");
        if (exclude) pattern = pattern.slice(1);
        if (pattern.includes("$TURBO_ROOT$")) {
          if (!pattern.startsWith("$TURBO_ROOT$/"))
            throw new Error("Invalid root output");
          pattern = pattern.slice("$TURBO_ROOT$/".length);
        } else
          pattern = path.posix.join(
            directory.split(path.sep).join("/"),
            pattern,
          );
        if (
          path.posix.isAbsolute(pattern) ||
          pattern.startsWith("../") ||
          pattern.includes("$")
        )
          throw new Error("Invalid output path");
        (exclude ? patterns.exclude : patterns.include).push(pattern);
      }
      outputs.push(patterns);
    };
    for (const [name, entry] of packages) {
      const names = new Set([
        ...Object.keys(entry.scripts),
        ...Object.keys(entry.tasks),
      ]);
      for (const key of Object.keys(rootTasks)) {
        const [owner, task] = key.split("#");
        if (
          task !== undefined &&
          (owner === name || (owner === "//" && entry.directory === "."))
        )
          names.add(task);
      }
      for (const task of names) {
        const declarations = [
          rootTasks[task],
          rootTasks[`${name}#${task}`],
          entry.directory === "." ? rootTasks[`//#${task}`] : undefined,
          entry.tasks[task],
        ]
          .filter((value) => value !== undefined)
          .map(object);
        if (declarations.length > 0)
          add(Object.assign({}, ...declarations), entry.directory);
      }
    }
    return outputs;
  } catch {
    return null;
  }
}

export async function hasPreservableStatus(
  stdout: string,
  root: string,
): Promise<boolean> {
  let outputs: Outputs[] | null | undefined;
  let remaining = 100_000;
  const regenerable = async (relative: string): Promise<boolean> => {
    if (--remaining < 0) return false;
    if (relative.split("/").some((part) => part.startsWith(".env")))
      return false;
    if (ALWAYS_OUTPUT.test(relative)) return true;
    if (
      !POSSIBLE_OUTPUT.test(relative) ||
      relative.split("/").some((part) => part.startsWith(".env"))
    )
      return false;
    outputs ??= await declaredOutputs(root);
    if (outputs === null) return false;
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) return false;
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink()) return false;
    if (info.isDirectory()) {
      const entries = await fs.readdir(filename);
      if (entries.length === 0)
        return outputs.some(
          (set) =>
            set.include.some((glob) => path.matchesGlob(relative, glob)) &&
            !set.exclude.some((glob) => path.matchesGlob(relative, glob)),
        );
      for (const entry of entries)
        if (!(await regenerable(`${relative.replace(/\/$/u, "")}/${entry}`)))
          return false;
      return true;
    }
    return outputs.some(
      (set) =>
        set.include.some((glob) => path.matchesGlob(relative, glob)) &&
        !set.exclude.some((glob) => path.matchesGlob(relative, glob)),
    );
  };
  try {
    for (const entry of stdout.split("\0")) {
      if (entry === "") continue;
      if (entry.slice(0, 2) !== "!!" || !(await regenerable(entry.slice(3))))
        return true;
    }
    return false;
  } catch {
    return true;
  }
}
