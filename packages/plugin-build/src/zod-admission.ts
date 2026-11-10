import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { init, parse } from "es-module-lexer";
import type { Metafile, transform } from "esbuild";
import { sourceTokens } from "./source-imports.js";
import { HOST_ZOD_NAMES } from "./generated/zod-admission.generated.js";

export async function zodUsageRejection(
  source: string,
  allowed: ReadonlySet<string>,
): Promise<string | null> {
  await init;
  const [imports] = parse(source);
  const namespaces = new Set<string>();
  let remaining = source;
  const zodImports = imports.filter(
    (item) => item.n === "zod" || item.n?.startsWith("zod/"),
  );
  if (!zodImports.length) return "Zod dependency is not a static ESM import";
  for (const item of zodImports) {
    if (item.n !== "zod" && item.n !== "zod/v4")
      return `unsupported subpath ${item.n}`;
    if (item.d !== -1) return "dynamic Zod import";
    const statement = source.slice(item.ss, item.se);
    if (!statement.startsWith("import ")) return "Zod re-export";
    const clause = statement.slice(7, statement.lastIndexOf("from")).trim();
    if (clause.startsWith("{")) {
      for (const entry of clause.slice(1, clause.lastIndexOf("}")).split(",")) {
        if (!entry.trim()) continue;
        const parts = entry.trim().split(/\s+as\s+/u);
        const name = parts[0]!;
        if (name === "z") namespaces.add(parts[1] ?? name);
        else if (!allowed.has(name)) return `unsupported export ${name}`;
      }
    } else {
      const namespace = /^(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)$/.exec(clause);
      if (!namespace) return "unsupported Zod import clause";
      namespaces.add(namespace[1]!);
    }
    remaining = remaining.replace(statement, " ");
  }
  const tokens = sourceTokens(remaining);
  if (
    namespaces.size &&
    tokens.some(
      (token) =>
        (token.kind === "punctuation" && token.value === "`") ||
        (token.kind === "identifier" &&
          (token.value === "eval" || token.value === "Function")),
    )
  )
    return "namespace use in interpolation or dynamic evaluation";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "identifier" || !namespaces.has(token.value)) continue;
    if (tokens[index - 1]?.value === "." && tokens[index - 2]?.value !== ".")
      continue;
    if (
      tokens[index + 1]?.value !== "." ||
      tokens[index + 2]?.kind !== "identifier"
    )
      return "Zod namespace escape or computed access";
    const name = tokens[index + 2]!.value;
    if (!allowed.has(name)) return `unsupported export ${name}`;
    let end = index + 3;
    while (tokens[end]?.value === "." && tokens[end + 1]?.kind === "identifier")
      end += 2;
    if (tokens[end]?.value === "[") return "computed Zod member access";
  }
  return null;
}

export async function pluginZodAdmission(
  metafile: Metafile,
  rootDir: string,
  transformSource: typeof transform,
  compatible: (path: string) => Promise<boolean>,
): Promise<{ shared: boolean; reason: string | null }> {
  let found = false;
  const allowed = new Set(HOST_ZOD_NAMES);
  for (const [input, info] of Object.entries(metafile.inputs)) {
    if (("/" + input.replace(/\\/g, "/")).includes("/node_modules/zod/"))
      continue;
    const zodEdges = info.imports.filter((edge) =>
      ("/" + edge.path.replace(/\\/g, "/")).includes("/node_modules/zod/"),
    );
    if (!zodEdges.length) continue;
    found = true;
    for (const edge of zodEdges)
      if (!(await compatible(resolve(rootDir, edge.path))))
        return {
          shared: false,
          reason: "incompatible, newer or unknown Zod version",
        };
    const path = resolve(rootDir, input);
    const source = await readFile(path, "utf8");
    const result = await transformSource(source, {
      loader: path.endsWith("tsx")
        ? "tsx"
        : path.endsWith("ts")
          ? "ts"
          : path.endsWith("jsx")
            ? "jsx"
            : "js",
      format: "esm",
      target: "es2022",
      supported: { "template-literal": false },
    });
    const reason = await zodUsageRejection(result.code, allowed);
    if (reason) return { shared: false, reason: `${input}: ${reason}` };
  }
  return { shared: found, reason: null };
}
