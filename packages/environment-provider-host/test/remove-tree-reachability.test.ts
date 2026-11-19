import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "generated",
  "test",
  "tests",
  "__tests__",
  ".turbo",
  "build",
  "bundled-types",
]);
const childEntry =
  "packages/environment-provider-host/src/remove-tree-child.ts";
const ioModule = "packages/environment-provider-host/src/remove-tree-io.ts";
const syncIoModule =
  "packages/environment-provider-host/src/remove-tree-sync-io.ts";
const coreModule =
  "packages/environment-provider-host/src/remove-directory-tree-core.ts";
const worktreeModule = "plugins/environment-git-worktree/host/worktree.ts";
const testHookCondition =
  "Object.values(walkHooks).some((hook) => hook !== undefined)";
const walkNames = ["removeDirectoryTree", "inspectTreeBeforeMove"];
const opaqueLoaderAllowlist: { file: string; count: number; reason: string }[] =
  [
    {
      file: "apps/app/scripts/terminal-search-color.browser.mjs",
      count: 1,
      reason:
        "build or packaging script; never runs in the daemon or the server",
    },
    {
      file: "apps/app/src/lib/plugin-frontend.ts",
      count: 1,
      reason:
        "browser code importing a served asset URL; it has no file system access",
    },
    {
      file: "apps/app/src/lib/split-prefetch.ts",
      count: 1,
      reason:
        "browser code importing a served asset URL; it has no file system access",
    },
    {
      file: "apps/desktop/scripts/smoke-packaged-npm.mjs",
      count: 2,
      reason:
        "build or packaging script; never runs in the daemon or the server",
    },
    {
      file: "apps/host-daemon/src/plugin-host-worker.ts",
      count: 1,
      reason:
        "loads a built plugin or provider artifact by path at run time; the artifact is bundled from scanned sources",
    },
    {
      file: "apps/server/src/services/plugins/plugin-runtime.ts",
      count: 1,
      reason:
        "loads a built plugin or provider artifact by path at run time; the artifact is bundled from scanned sources",
    },
    {
      file: "packages/plugin-build/scripts/generate-runtime-export-manifest.mjs",
      count: 1,
      reason:
        "build or packaging script; never runs in the daemon or the server",
    },
    {
      file: "packages/plugin-build/src/build-plugin-app.ts",
      count: 5,
      reason:
        "loads the plugin facade module it is building and the build toolchain packages (esbuild, tailwind)",
    },
    {
      file: "packages/plugin-build/src/build-plugin-host.ts",
      count: 1,
      reason:
        "loads a build toolchain package (esbuild, tailwind) located at build time",
    },
    {
      file: "packages/plugin-build/src/build-plugin-server.ts",
      count: 1,
      reason:
        "loads a build toolchain package (esbuild, tailwind) located at build time",
    },
    {
      file: "packages/plugin-build/src/prepare-plugin-runtime.ts",
      count: 1,
      reason: "runs a plugin's own stage-assets build script",
    },
    {
      file: "packages/provider-bridge-protocol/src/bridge-worker-entry.ts",
      count: 1,
      reason:
        "loads a built plugin or provider artifact by path at run time; the artifact is bundled from scanned sources",
    },
    {
      file: "packages/provider-parity/src/leg.ts",
      count: 1,
      reason: "parity harness loading a module from a recorded checkout",
    },
    {
      file: "plugins/monaco-editor/lib/monaco-loader.ts",
      count: 1,
      reason:
        "browser code importing a served asset URL; it has no file system access",
    },
    {
      file: "plugins/monaco-editor/scripts/stage-assets.mjs",
      count: 1,
      reason:
        "build or packaging script; never runs in the daemon or the server",
    },
    {
      file: "plugins/monaco-editor/server.ts",
      count: 1,
      reason: "runs the plugin's own stage-assets build script on first use",
    },
    {
      file: "plugins/provider-pi/src/bridge/fake-pi-rpc.mjs",
      count: 1,
      reason:
        "fake pi binary for provider tests loading the pi module under test",
    },
  ];

function productionSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name))
        found.push(...productionSources(full));
    } else if (
      /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(entry.name) &&
      !/\.d\.[cm]?ts$/u.test(entry.name) &&
      !/\.(test|spec|test-d)\.[cm]?[jt]sx?$/u.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
}

function repositoryPath(full: string): string {
  return path.relative(repositoryRoot, full).split(path.sep).join("/");
}

interface Resolver {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
}

const resolvers = new Map<string, Resolver>();

function resolverFor(file: string): Resolver {
  let directory = path.dirname(file);
  while (
    !fs.existsSync(path.join(directory, "tsconfig.json")) &&
    directory !== repositoryRoot
  )
    directory = path.dirname(directory);
  const cached = resolvers.get(directory);
  if (cached !== undefined) return cached;
  const configPath = path.join(directory, "tsconfig.json");
  const config = fs.existsSync(configPath)
    ? ts.readConfigFile(configPath, ts.sys.readFile).config
    : {};
  const options = {
    ...ts.parseJsonConfigFileContent(config, ts.sys, directory).options,
    allowJs: true,
  };
  const resolver = {
    options,
    cache: ts.createModuleResolutionCache(directory, (name) => name, options),
  };
  resolvers.set(directory, resolver);
  return resolver;
}

function resolveSpecifier(specifier: string, file: string): string | undefined {
  const { options, cache } = resolverFor(file);
  const resolved = ts.resolveModuleName(
    specifier,
    file,
    options,
    ts.sys,
    cache,
  ).resolvedModule;
  if (resolved === undefined) return undefined;
  const real = fs.realpathSync(resolved.resolvedFileName);
  const relative = repositoryPath(real);
  if (relative.startsWith("..") || relative.includes("node_modules/"))
    return undefined;
  return relative;
}

function namesSourceModule(file: string, specifier: string): boolean {
  if (specifier.includes("?")) return false;
  const name = path.posix.basename(specifier);
  if (/\.[a-z0-9]+$/iu.test(name) && !/\.[cm]?[jt]sx?$/u.test(name))
    return false;
  if (!specifier.startsWith(".")) return true;
  const target = path.resolve(repositoryRoot, path.dirname(file), specifier);
  return !repositoryPath(target)
    .split("/")
    .some((segment) => skippedDirectories.has(segment));
}

type Binding =
  | { kind: "named"; imported: string; local: string }
  | { kind: "namespace"; local: string }
  | { kind: "all" };

interface ModuleEdge {
  specifier: string;
  target: string | undefined;
  dynamic: boolean;
  reexport: boolean;
  bindings: Binding[];
  line: number;
}

interface ModuleRecord {
  file: string;
  sourceFile: ts.SourceFile;
  edges: ModuleEdge[];
  opaqueLoads: number[];
  localExports: { local: string; exported: string }[];
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function readModule(full: string): ModuleRecord {
  const file = repositoryPath(full);
  const sourceFile = ts.createSourceFile(
    full,
    fs.readFileSync(full, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const edges: ModuleEdge[] = [];
  const opaqueLoads: number[] = [];
  const localExports: { local: string; exported: string }[] = [];
  const add = (
    node: ts.Node,
    specifier: string,
    dynamic: boolean,
    reexport: boolean,
    bindings: Binding[],
  ) =>
    edges.push({
      specifier,
      target: resolveSpecifier(specifier, full),
      dynamic,
      reexport,
      bindings,
      line: lineOf(sourceFile, node),
    });
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (clause?.isTypeOnly !== true) {
        const bindings: Binding[] = [];
        if (clause?.name !== undefined)
          bindings.push({
            kind: "named",
            imported: "default",
            local: clause.name.text,
          });
        const named = clause?.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named))
          bindings.push({ kind: "namespace", local: named.name.text });
        if (named !== undefined && ts.isNamedImports(named))
          for (const element of named.elements)
            if (!element.isTypeOnly)
              bindings.push({
                kind: "named",
                imported: (element.propertyName ?? element.name).text,
                local: element.name.text,
              });
        add(node, node.moduleSpecifier.text, false, false, bindings);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const clause = node.exportClause;
      if (
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const bindings: Binding[] = [];
        if (clause === undefined) bindings.push({ kind: "all" });
        else if (ts.isNamespaceExport(clause))
          bindings.push({ kind: "namespace", local: clause.name.text });
        else
          for (const element of clause.elements)
            if (!element.isTypeOnly)
              bindings.push({
                kind: "named",
                imported: (element.propertyName ?? element.name).text,
                local: element.name.text,
              });
        add(node, node.moduleSpecifier.text, false, true, bindings);
      } else if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements)
          if (!element.isTypeOnly)
            localExports.push({
              local: (element.propertyName ?? element.name).text,
              exported: element.name.text,
            });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression.text, true, false, []);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0];
      if (specifier !== undefined && ts.isStringLiteralLike(specifier))
        add(node, specifier.text, true, false, []);
      else opaqueLoads.push(lineOf(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { file, sourceFile, edges, opaqueLoads, localExports };
}

function walkExports(modules: Map<string, ModuleRecord>) {
  const exports = new Map<string, Map<string, string>>([
    [coreModule, new Map(walkNames.map((name) => [name, name]))],
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of modules.values()) {
      if (record.file === coreModule) continue;
      const found = new Map(exports.get(record.file) ?? []);
      const imported = new Map<string, string>();
      for (const edge of record.edges) {
        const source =
          edge.target === undefined ? undefined : exports.get(edge.target);
        if (source === undefined || edge.dynamic) continue;
        for (const binding of edge.bindings) {
          if (binding.kind === "all" && edge.reexport)
            for (const [name, walk] of source) found.set(name, walk);
          if (binding.kind === "named" && source.has(binding.imported)) {
            if (edge.reexport)
              found.set(binding.local, source.get(binding.imported)!);
            else imported.set(binding.local, source.get(binding.imported)!);
          }
        }
      }
      for (const { local, exported } of record.localExports)
        if (imported.has(local)) found.set(exported, imported.get(local)!);
      if (found.size !== (exports.get(record.file)?.size ?? 0)) {
        exports.set(record.file, found);
        changed = true;
      }
    }
  }
  return exports;
}

function insideTestHookBranch(node: ts.Node, sourceFile: ts.SourceFile) {
  for (
    let current = node.parent;
    current !== undefined;
    current = current.parent
  )
    if (
      ts.isIfStatement(current) &&
      current.expression.getText(sourceFile) === testHookCondition
    )
      return true;
  return false;
}

function partOfModuleSyntax(node: ts.Node): boolean {
  for (
    let current = node.parent;
    current !== undefined;
    current = current.parent
  )
    if (
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current) ||
      ts.isExportSpecifier(current)
    )
      return true;
  return false;
}

it("keeps the synchronous tree walk reachable only from the removal child and the worktree test hooks", () => {
  const files = ["apps", "packages", "plugins"].flatMap((top) =>
    productionSources(path.join(repositoryRoot, top)),
  );
  expect(files.length).toBeGreaterThan(100);
  const modules = new Map(
    files.map((full) => {
      const record = readModule(full);
      return [record.file, record] as const;
    }),
  );
  const violations: string[] = [];

  const unresolvedWorkspace = [...modules.values()].flatMap((record) =>
    record.edges
      .filter(
        (edge) =>
          edge.target === undefined &&
          /^(\.|bb-environment-provider-host(\/|$))/u.test(edge.specifier) &&
          namesSourceModule(record.file, edge.specifier),
      )
      .map((edge) => `${record.file}:${edge.line} ${edge.specifier}`),
  );
  expect(unresolvedWorkspace).toEqual([]);
  expect(
    modules
      .get(childEntry)!
      .edges.some((edge) => edge.target === syncIoModule && !edge.dynamic),
  ).toBe(true);
  expect(
    modules
      .get(worktreeModule)!
      .edges.some(
        (edge) =>
          edge.specifier ===
            "bb-environment-provider-host/remove-directory-tree" &&
          edge.target ===
            "packages/environment-provider-host/src/remove-directory-tree.ts",
      ),
  ).toBe(true);

  const importers = new Map<string, Set<string>>();
  for (const record of modules.values())
    for (const edge of record.edges)
      if (edge.target !== undefined) {
        const set = importers.get(edge.target) ?? new Set<string>();
        set.add(record.file);
        importers.set(edge.target, set);
      }
  const reachers = new Set<string>();
  const pending = [syncIoModule];
  while (pending.length > 0)
    for (const importer of importers.get(pending.pop()!) ?? [])
      if (!reachers.has(importer)) {
        reachers.add(importer);
        pending.push(importer);
      }
  for (const reacher of [...reachers].sort())
    if (reacher !== childEntry)
      violations.push(`${reacher} reaches the synchronous backend`);

  for (const record of modules.values()) {
    if (record.file === childEntry) continue;
    for (const edge of record.edges) {
      if (
        edge.dynamic &&
        (edge.target === syncIoModule || edge.target === coreModule)
      )
        violations.push(
          `${record.file}:${edge.line} loads ${edge.target} dynamically`,
        );
      if (
        edge.target === ioModule &&
        record.file !== coreModule &&
        record.file !== syncIoModule &&
        (edge.dynamic ||
          edge.bindings.some(
            (binding) =>
              binding.kind !== "named" ||
              binding.imported === "installRemoveTreeIo",
          ))
      )
        violations.push(
          `${record.file}:${edge.line} can replace the tree backend`,
        );
    }
  }

  const exports = walkExports(modules);
  const allowedCalls: string[] = [];
  for (const record of modules.values()) {
    if (record.file === coreModule) continue;
    const named = new Map<string, string>();
    const namespaces = new Map<string, Map<string, string>>();
    for (const edge of record.edges) {
      const source =
        edge.target === undefined ? undefined : exports.get(edge.target);
      if (source === undefined || edge.reexport) continue;
      if (edge.dynamic && record.file !== childEntry) {
        violations.push(
          `${record.file}:${edge.line} loads the tree walk dynamically from ${edge.target}`,
        );
        continue;
      }
      for (const binding of edge.bindings) {
        if (binding.kind === "named" && source.has(binding.imported))
          named.set(binding.local, source.get(binding.imported)!);
        if (binding.kind === "namespace") namespaces.set(binding.local, source);
      }
    }
    if (named.size === 0 && namespaces.size === 0) continue;
    const sourceFile = record.sourceFile;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !partOfModuleSyntax(node)) {
        const parent = node.parent;
        let reference: ts.Expression | undefined;
        if (
          named.has(node.text) &&
          !(ts.isPropertyAccessExpression(parent) && parent.name === node)
        )
          reference = node;
        if (namespaces.has(node.text)) {
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node
          ) {
            if (namespaces.get(node.text)!.has(parent.name.text))
              reference = parent;
          } else {
            violations.push(
              `${record.file}:${lineOf(sourceFile, node)} passes on a module that holds the tree walk`,
            );
          }
        }
        if (reference !== undefined) {
          const call =
            ts.isCallExpression(reference.parent) &&
            reference.parent.expression === reference;
          const allowed =
            call &&
            (record.file === childEntry ||
              (record.file === worktreeModule &&
                insideTestHookBranch(reference, sourceFile)));
          const where = `${record.file}:${lineOf(sourceFile, reference)}`;
          if (allowed) allowedCalls.push(record.file);
          else
            violations.push(
              `${where} walks the tree in the calling process: ${reference.getText(sourceFile)}`,
            );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const allowance = new Map(
    opaqueLoaderAllowlist.map((entry) => [entry.file, entry.count]),
  );
  const opaqueFiles = new Set<string>();
  for (const record of modules.values()) {
    if (record.opaqueLoads.length === 0) continue;
    opaqueFiles.add(record.file);
    if (record.opaqueLoads.length !== allowance.get(record.file))
      violations.push(
        `${record.file}:${record.opaqueLoads.join(",")} loads a module through a non-literal specifier (${record.opaqueLoads.length} found, ${allowance.get(record.file) ?? 0} allowed)`,
      );
  }
  expect(
    opaqueLoaderAllowlist
      .filter((entry) => !opaqueFiles.has(entry.file))
      .map((entry) => entry.file),
  ).toEqual([]);

  expect(violations).toEqual([]);
  expect(allowedCalls.sort()).toEqual([
    childEntry,
    childEntry,
    worktreeModule,
    worktreeModule,
  ]);
}, 120_000);
