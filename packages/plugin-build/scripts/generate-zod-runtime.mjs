import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const excluded = new Set([
  "strictObject",
  "NEVER",
  "ZodError",
  "never",
  "email",
  "intersection",
]);

export function zodSourceUsage(source) {
  const ast = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const namespaces = new Set();
  const names = new Set();
  const edges = [];
  for (const node of ast.statements) {
    if (
      !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
      !node.moduleSpecifier ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      continue;
    const specifier = node.moduleSpecifier.text;
    if (node.isTypeOnly || node.importClause?.isTypeOnly) continue;
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.every((e) => e.isTypeOnly)
    )
      continue;
    if (specifier === "zod" || specifier === "zod/v4") {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.add(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const binding of clause.namedBindings.elements) {
          if (binding.isTypeOnly) continue;
          const name = (binding.propertyName ?? binding.name).text;
          if (name === "z") namespaces.add(binding.name.text);
          else names.add(name);
        }
    } else edges.push(specifier);
  }
  function visit(node) {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node
      )
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return {
    names: [...names].filter((name) => !excluded.has(name)).sort(),
    edges,
  };
}

export async function collectHostZodNames(entry, resolveImport) {
  const pending = [entry];
  const visited = new Set();
  const names = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (
      visited.has(path) ||
      !/\.[cm]?[jt]sx?$/.test(path) ||
      path.endsWith(".d.ts")
    )
      continue;
    visited.add(path);
    const usage = zodSourceUsage(await readFile(path, "utf8"));
    for (const name of usage.names) names.add(name);
    for (const edge of usage.edges) {
      const target = await resolveImport(edge, path);
      if (target) pending.push(target);
    }
  }
  return [...names].sort();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let names = [];
  let zodPath = "";
  await build({
    stdin: { contents: "", resolveDir: root },
    write: false,
    bundle: true,
    platform: "browser",
    conditions: ["source"],
    tsconfig: resolve(root, "apps/app/tsconfig.json"),
    logLevel: "silent",
    plugins: [
      {
        name: "host-zod-source-graph",
        setup(context) {
          context.onStart(async () => {
            zodPath = (
              await context.resolve("zod", {
                resolveDir: resolve(root, "apps/app"),
                kind: "import-statement",
              })
            ).path;
            names = await collectHostZodNames(
              resolve(root, "apps/app/src/main.tsx"),
              async (specifier, importer) => {
                const result = await context.resolve(specifier, {
                  resolveDir: dirname(importer),
                  kind: "import-statement",
                });
                return result.errors.length || result.external
                  ? null
                  : result.path;
              },
            );
          });
        },
      },
    ],
  });
  const dir = resolve(root, "packages/plugin-build/src/generated");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "zod-admission.generated.json"),
    JSON.stringify(names),
  );
  await writeFile(
    resolve(dir, "zod-admission.generated.ts"),
    `export const HOST_ZOD_NAMES: readonly string[] = ${JSON.stringify(names)};\n`,
  );
  const aliases = names.map((name, index) => `${name} as value${index}`);
  const fields = names.map(
    (name, index) => `${JSON.stringify(name)}: value${index}`,
  );
  const modulePath = relative(dir, zodPath).replaceAll("\\", "/");
  await writeFile(
    resolve(dir, "zod-runtime.generated.ts"),
    `import { ${aliases.join(", ")} } from ${JSON.stringify(modulePath)};\nconst values = { ${fields.join(", ")} };\nexport const zodRuntimeSlots = { zod: { ...values, z: values, default: values } };\n`,
  );
  console.log(`host Zod static source usage: ${names.join(", ")}`);
}
