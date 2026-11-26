import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type BackgroundScopedItemKind,
  FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS,
  legacyWorkerAssumesZeroOpenBackgroundWork,
} from "./legacy-worker-open-work.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const PROTOCOL_THREAD_DELTA_PATH = path.join(
  REPO_ROOT,
  "packages/provider-bridge-protocol/src/thread-delta.ts",
);

const AGENT_RUNTIME_TSCONFIG_PATH = path.join(
  REPO_ROOT,
  "packages/agent-runtime/tsconfig.json",
);

const PLUGIN_ADAPTER_SOURCE_ROOTS: Record<
  keyof typeof FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS,
  readonly string[]
> = {
  "provider-acp": [
    "plugins/provider-acp/src",
    "packages/provider-bridge-acp/src",
  ],
  "provider-claude-code": ["plugins/provider-claude-code/src"],
  "provider-codex": ["plugins/provider-codex/src"],
  "provider-pi": ["plugins/provider-pi/src"],
};

const BACKGROUND_SCOPED_SHAPE_FIELDS = new Set([
  "familyId",
  "taskStatus",
  "skipTranscript",
  "childRef",
  "background",
]);

export interface BackgroundScopedItemScanResult {
  kinds: BackgroundScopedItemKind[];
  unresolvedItemTypes: string[];
}

export function assertCertifiedBackgroundScopedItems(
  scan: BackgroundScopedItemScanResult,
): BackgroundScopedItemKind[] {
  if (scan.unresolvedItemTypes.length > 0) {
    throw new Error(
      `Cannot certify adapter open-work kinds due to unresolved item type(s): ${scan.unresolvedItemTypes.join("; ")}`,
    );
  }
  return scan.kinds;
}

function collectAdapterSourceFiles(relativeDir: string): string[] {
  const rootDir = path.join(REPO_ROOT, relativeDir);
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "__tests__" ||
        entry.name === "__fixtures__" ||
        entry.name === "dist" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        results.push(fullPath);
      }
    }
  };
  visit(rootDir);
  return results.sort();
}

function readCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const configRead = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configRead.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configRead.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configRead.config,
    ts.sys,
    path.dirname(tsconfigPath),
  );
  return parsed.options;
}

function getDeltaItemShapeType(
  program: ts.Program,
  checker: ts.TypeChecker,
): ts.Type {
  const protocolFile = program.getSourceFile(PROTOCOL_THREAD_DELTA_PATH);
  if (protocolFile === undefined) {
    throw new Error(`Missing protocol source file: ${PROTOCOL_THREAD_DELTA_PATH}`);
  }
  for (const statement of protocolFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "DeltaItemShape"
    ) {
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol !== undefined) {
        return checker.getDeclaredTypeOfSymbol(symbol);
      }
    }
  }
  throw new Error("DeltaItemShape not found in thread-delta.ts");
}

function isZodSchemaObjectLiteral(node: ts.ObjectLiteralExpression): boolean {
  return Boolean(
    node.parent !== undefined &&
      ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      ts.isIdentifier(node.parent.expression.expression) &&
      node.parent.expression.expression.text === "z",
  );
}

function isJsonStringifyArgument(node: ts.ObjectLiteralExpression): boolean {
  return Boolean(
    node.parent !== undefined &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments[0] === node &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      ts.isIdentifier(node.parent.expression.expression) &&
      node.parent.expression.expression.text === "JSON" &&
      node.parent.expression.name.text === "stringify",
  );
}

function resolvePropertyNames(
  checker: ts.TypeChecker,
  nameNode: ts.PropertyName,
): { names: string[]; unresolved: boolean } {
  if (
    ts.isIdentifier(nameNode) ||
    ts.isStringLiteral(nameNode) ||
    ts.isNumericLiteral(nameNode)
  ) {
    return { names: [nameNode.text], unresolved: false };
  }
  if (ts.isComputedPropertyName(nameNode)) {
    const computedType = checker.getTypeAtLocation(nameNode.expression);
    const parts = computedType.isUnion() ? computedType.types : [computedType];
    if (
      parts.length > 0 &&
      parts.every((part) => (part.flags & ts.TypeFlags.StringLiteral) !== 0)
    ) {
      return {
        names: parts.map((part) => (part as ts.StringLiteralType).value),
        unresolved: false,
      };
    }
    if (
      parts.length > 0 &&
      parts.every(
        (part) =>
          (part.flags &
            (ts.TypeFlags.UniqueESSymbol |
              ts.TypeFlags.ESSymbolLike |
              ts.TypeFlags.NumberLiteral |
              ts.TypeFlags.Number)) !==
          0,
      )
    ) {
      return { names: [], unresolved: false };
    }
    return { names: [], unresolved: true };
  }
  return { names: [], unresolved: false };
}

function typeOfObjectPropertyNode(
  checker: ts.TypeChecker,
  prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): ts.Type {
  if (ts.isPropertyAssignment(prop)) {
    return checker.getTypeAtLocation(prop.initializer);
  }
  const valueSymbol = checker.getShorthandAssignmentValueSymbol(prop);
  if (valueSymbol?.valueDeclaration !== undefined) {
    return checker.getTypeAtLocation(valueSymbol.valueDeclaration);
  }
  return checker.getTypeAtLocation(prop);
}

function spreadCanSupplyProperty(
  checker: ts.TypeChecker,
  spreadExpr: ts.Expression,
  propertyName: string,
): boolean {
  const spreadType = checker.getTypeAtLocation(spreadExpr);
  const parts = spreadType.isUnion() ? spreadType.types : [spreadType];
  return parts.some((part) => {
    if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return true;
    }
    if (checker.getIndexTypeOfType(part, ts.IndexKind.String) !== undefined) {
      return true;
    }
    return part.getProperty(propertyName) !== undefined;
  });
}

function hasUnsafeItemTypeConstituent(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  exprType: ts.Type,
): boolean {
  const parts = exprType.isUnion() ? exprType.types : [exprType];
  return parts.some((part) => {
    if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return true;
    }
    const typeSymbol = part.getProperty("type");
    if (typeSymbol === undefined) {
      return true;
    }
    const typePropType = checker.getTypeOfSymbolAtLocation(typeSymbol, expr);
    const typeParts = typePropType.isUnion()
      ? typePropType.types
      : [typePropType];
    return typeParts.some(
      (constituent) => (constituent.flags & ts.TypeFlags.StringLiteral) === 0,
    );
  });
}

function analyzeSourceFileInProgram(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  deltaItemShapeType: ts.Type,
): BackgroundScopedItemScanResult {
  const discovered = new Set<BackgroundScopedItemKind>();
  const unresolvedItemTypes: string[] = [];

  const formatLocation = (node: ts.Node): string => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const displayPath = sourceFile.fileName.startsWith(REPO_ROOT)
      ? path.relative(REPO_ROOT, sourceFile.fileName)
      : path.basename(sourceFile.fileName);
    return `${displayPath}:${line + 1}`;
  };

  const recordKindsFromStringLiterals = (
    literalKinds: readonly string[],
    bgProp:
      | ts.PropertyAssignment
      | ts.ShorthandPropertyAssignment
      | undefined,
    bgPropIndex: number,
    spreads: readonly { expr: ts.Expression; index: number }[],
  ): void => {
    for (const kind of literalKinds) {
      if (kind === "backgroundTask") {
        discovered.add("backgroundTask");
      } else if (kind === "delegation") {
        const overriddenByLaterSpread =
          bgProp !== undefined &&
          spreads.some(
            (spread) =>
              spread.index > bgPropIndex &&
              spreadCanSupplyProperty(checker, spread.expr, "background"),
          );
        let explicitlyForeground = false;
        if (bgProp !== undefined && !overriddenByLaterSpread) {
          const bgType = typeOfObjectPropertyNode(checker, bgProp);
          const bgParts = bgType.isUnion() ? bgType.types : [bgType];
          explicitlyForeground =
            bgParts.length > 0 &&
            bgParts.every(
              (part) =>
                (part.flags & ts.TypeFlags.BooleanLiteral) !== 0 &&
                checker.typeToString(part) === "false",
            );
        }
        if (!explicitlyForeground) {
          discovered.add("delegation");
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const targetType = checker.getTypeAtLocation(node);
      const targetParts = targetType.isUnion()
        ? targetType.types
        : [targetType];
      const targetsDeltaItem = targetParts.some(
        (part) =>
          (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
          checker.isTypeAssignableTo(part, deltaItemShapeType),
      );
      if (targetsDeltaItem) {
        const sourceType = checker.getTypeAtLocation(node.expression);
        if (hasUnsafeItemTypeConstituent(checker, node.expression, sourceType)) {
          unresolvedItemTypes.push(
            `${formatLocation(node)} (unsafe type assertion to DeltaItemShape)`,
          );
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "assign"
    ) {
      const returnType = checker.getTypeAtLocation(node);
      const returnParts = returnType.isUnion()
        ? returnType.types
        : [returnType];
      if (
        returnParts.some(
          (part) =>
            (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
            checker.isTypeAssignableTo(part, deltaItemShapeType),
        )
      ) {
        unresolvedItemTypes.push(
          `${formatLocation(node)} (Object.assign producing DeltaItemShape)`,
        );
      }
    }

    if (
      ts.isObjectLiteralExpression(node) &&
      !isZodSchemaObjectLiteral(node) &&
      !isJsonStringifyArgument(node)
    ) {
      let typeProp:
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
        | undefined;
      let typePropIndex = -1;
      let bgProp:
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
        | undefined;
      let bgPropIndex = -1;
      let hasBackgroundShapeField = false;
      let hasUnresolvedComputedProperty = false;
      const spreads: { expr: ts.Expression; index: number }[] = [];

      node.properties.forEach((prop, index) => {
        if (ts.isSpreadAssignment(prop)) {
          spreads.push({ expr: prop.expression, index });
          return;
        }
        if (
          ts.isPropertyAssignment(prop) ||
          ts.isShorthandPropertyAssignment(prop)
        ) {
          const resolved = resolvePropertyNames(checker, prop.name);
          if (resolved.unresolved) {
            hasUnresolvedComputedProperty = true;
          }
          for (const propName of resolved.names) {
            if (propName === "type") {
              typeProp = prop;
              typePropIndex = index;
            }
            if (propName === "background") {
              bgProp = prop;
              bgPropIndex = index;
            }
            if (BACKGROUND_SCOPED_SHAPE_FIELDS.has(propName)) {
              hasBackgroundShapeField = true;
            }
          }
        }
      });

      const contextualType = checker.getContextualType(node);
      const contextualParts =
        contextualType !== undefined
          ? (contextualType.isUnion()
              ? contextualType.types
              : [contextualType]
            ).filter(
              (part) =>
                (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ===
                0,
            )
          : [];
      const insideTypeAssertion = Boolean(
        node.parent !== undefined &&
          (ts.isAsExpression(node.parent) ||
            ts.isTypeAssertionExpression(node.parent)),
      );
      const contextAssignsToDeltaItem = contextualParts.some(
        (part) =>
          (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
          checker.isTypeAssignableTo(part, deltaItemShapeType),
      );
      const contextCouldBeDeltaItem =
        contextualParts.length === 0 ||
        contextualParts.some(
          (part) =>
            (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
            checker.isTypeAssignableTo(part, deltaItemShapeType),
        );

      if (
        hasUnresolvedComputedProperty &&
        (hasBackgroundShapeField ||
          insideTypeAssertion ||
          contextAssignsToDeltaItem)
      ) {
        unresolvedItemTypes.push(
          `${formatLocation(node)} (unresolved computed property)`,
        );
      }

      if (
        typeProp === undefined &&
        spreads.length > 0 &&
        contextAssignsToDeltaItem
      ) {
        for (const spread of spreads) {
          const spreadType = checker.getTypeAtLocation(spread.expr);
          if (hasUnsafeItemTypeConstituent(checker, spread.expr, spreadType)) {
            unresolvedItemTypes.push(
              `${formatLocation(spread.expr)} (spread with unresolved item type)`,
            );
          }
        }
      }

      if (typeProp !== undefined) {
        const valType = typeOfObjectPropertyNode(checker, typeProp);
        const valParts = valType.isUnion() ? valType.types : [valType];
        const isZodValue = valParts.every((part) =>
          checker.typeToString(part).startsWith("Zod"),
        );

        if (!isZodValue) {
          const allStringLiterals =
            valParts.length > 0 &&
            valParts.every(
              (part) => (part.flags & ts.TypeFlags.StringLiteral) !== 0,
            );

          if (allStringLiterals) {
            recordKindsFromStringLiterals(
              valParts.map((part) => (part as ts.StringLiteralType).value),
              bgProp,
              bgPropIndex,
              spreads,
            );
            for (const spread of spreads) {
              if (
                spread.index > typePropIndex &&
                spreadCanSupplyProperty(checker, spread.expr, "type")
              ) {
                const spreadType = checker.getTypeAtLocation(spread.expr);
                if (
                  hasUnsafeItemTypeConstituent(checker, spread.expr, spreadType)
                ) {
                  if (
                    hasBackgroundShapeField ||
                    insideTypeAssertion ||
                    contextCouldBeDeltaItem
                  ) {
                    unresolvedItemTypes.push(
                      `${formatLocation(spread.expr)} (spread after type with unresolved item type)`,
                    );
                  }
                } else {
                  const spreadParts = spreadType.isUnion()
                    ? spreadType.types
                    : [spreadType];
                  const spreadKinds: string[] = [];
                  for (const part of spreadParts) {
                    const sym = part.getProperty("type");
                    if (sym === undefined) continue;
                    const symType = checker.getTypeOfSymbolAtLocation(
                      sym,
                      spread.expr,
                    );
                    const symParts = symType.isUnion()
                      ? symType.types
                      : [symType];
                    for (const sp of symParts) {
                      if ((sp.flags & ts.TypeFlags.StringLiteral) !== 0) {
                        spreadKinds.push((sp as ts.StringLiteralType).value);
                      }
                    }
                  }
                  recordKindsFromStringLiterals(
                    spreadKinds,
                    bgProp,
                    bgPropIndex,
                    spreads,
                  );
                }
              }
            }
          } else if (
            hasBackgroundShapeField ||
            insideTypeAssertion ||
            contextCouldBeDeltaItem
          ) {
            unresolvedItemTypes.push(
              `${formatLocation(node)} (unresolved item type: ${checker.typeToString(valType)})`,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    kinds: [...discovered].sort(),
    unresolvedItemTypes,
  };
}

export function scanPluginAdapterSources(
  pluginId: keyof typeof PLUGIN_ADAPTER_SOURCE_ROOTS,
): BackgroundScopedItemScanResult {
  const roots = PLUGIN_ADAPTER_SOURCE_ROOTS[pluginId];
  const files = roots.flatMap((root) => collectAdapterSourceFiles(root));
  if (files.length === 0) {
    throw new Error(`No adapter source files found for ${pluginId}`);
  }
  const tsconfigPath = path.join(REPO_ROOT, roots[0]!, "../tsconfig.json");
  const options = readCompilerOptions(tsconfigPath);
  const program = ts.createProgram({
    rootNames: [...new Set([...files, PROTOCOL_THREAD_DELTA_PATH])],
    options,
  });
  const checker = program.getTypeChecker();
  const deltaItemShapeType = getDeltaItemShapeType(program, checker);
  const targetSet = new Set(files);

  const kinds = new Set<BackgroundScopedItemKind>();
  const unresolvedItemTypes: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!targetSet.has(sourceFile.fileName)) continue;
    const result = analyzeSourceFileInProgram(
      sourceFile,
      checker,
      deltaItemShapeType,
    );
    for (const kind of result.kinds) {
      kinds.add(kind);
    }
    unresolvedItemTypes.push(...result.unresolvedItemTypes);
  }
  return {
    kinds: [...kinds].sort(),
    unresolvedItemTypes,
  };
}

export function scanSyntheticAdapterSources(
  sources: Record<string, string>,
): Record<string, BackgroundScopedItemScanResult> {
  const options = readCompilerOptions(AGENT_RUNTIME_TSCONFIG_PATH);
  const virtualDir = path.join(REPO_ROOT, "packages/agent-runtime/src/__virtual__");
  const virtualByPath = new Map<string, string>();
  for (const [name, content] of Object.entries(sources)) {
    virtualByPath.set(path.join(virtualDir, name), content);
  }

  const baseHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) =>
      virtualByPath.has(path.normalize(fileName)) ||
      baseHost.fileExists(fileName),
    readFile: (fileName) => {
      const normalized = path.normalize(fileName);
      const virtualContent = virtualByPath.get(normalized);
      return virtualContent !== undefined
        ? virtualContent
        : baseHost.readFile(fileName);
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNew) => {
      const normalized = path.normalize(fileName);
      const virtualContent = virtualByPath.get(normalized);
      if (virtualContent !== undefined) {
        return ts.createSourceFile(
          normalized,
          virtualContent,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNew,
      );
    },
  };

  const program = ts.createProgram({
    rootNames: [...virtualByPath.keys(), PROTOCOL_THREAD_DELTA_PATH],
    options,
    host,
  });
  const checker = program.getTypeChecker();
  const deltaItemShapeType = getDeltaItemShapeType(program, checker);

  const output: Record<string, BackgroundScopedItemScanResult> = {};
  for (const [name] of Object.entries(sources)) {
    const virtualPath = path.join(virtualDir, name);
    const sourceFile = program.getSourceFile(virtualPath);
    if (sourceFile === undefined) {
      throw new Error(`Missing virtual source file: ${virtualPath}`);
    }
    output[name] = analyzeSourceFileInProgram(
      sourceFile,
      checker,
      deltaItemShapeType,
    );
  }
  return output;
}

describe("FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS", () => {
  it("covers every first-party host-bridged provider plugin and its shared bridge packages", () => {
    const pluginsDir = path.join(REPO_ROOT, "plugins");
    const hostBridgedPlugins: string[] = [];

    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("provider-")) continue;
      const pkgPath = path.join(pluginsDir, entry.name, "package.json");
      try {
        statSync(pkgPath);
      } catch {
        continue;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        bb?: { host?: unknown };
        dependencies?: Record<string, string>;
      };
      if (pkg.bb?.host === undefined) continue;
      hostBridgedPlugins.push(entry.name);

      const sharedBridgeDeps = Object.keys(pkg.dependencies ?? {}).filter(
        (dep) =>
          dep.startsWith("@bb/provider-bridge-") &&
          dep !== "@bb/provider-bridge-protocol",
      );
      const mappedRoots =
        PLUGIN_ADAPTER_SOURCE_ROOTS[
          entry.name as keyof typeof PLUGIN_ADAPTER_SOURCE_ROOTS
        ] ?? [];
      for (const dep of sharedBridgeDeps) {
        const expectedRoot = `packages/${dep.slice("@bb/".length)}/src`;
        expect(mappedRoots).toContain(expectedRoot);
      }
    }

    expect(hostBridgedPlugins.sort()).toEqual(
      Object.keys(FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS).sort(),
    );
  });

  it("matches the background-scoped delta items emitted by each adapter and fails closed on unresolved types", () => {
    const actual: Record<string, BackgroundScopedItemKind[]> = {};

    for (const pluginId of Object.keys(
      PLUGIN_ADAPTER_SOURCE_ROOTS,
    ) as (keyof typeof PLUGIN_ADAPTER_SOURCE_ROOTS)[]) {
      const scan = scanPluginAdapterSources(pluginId);
      expect(scan.unresolvedItemTypes).toEqual([]);
      actual[pluginId] = assertCertifiedBackgroundScopedItems(scan);
    }

    expect(actual).toEqual({
      "provider-acp": [
        ...FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS["provider-acp"],
      ],
      "provider-claude-code": [
        ...FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS[
          "provider-claude-code"
        ],
      ],
      "provider-codex": [
        ...FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS["provider-codex"],
      ],
      "provider-pi": [
        ...FIRST_PARTY_BRIDGE_PLUGIN_BACKGROUND_SCOPED_ITEMS["provider-pi"],
      ],
    });
  }, 30_000);

  it("detects literal and union-typed dynamic backgroundTask and delegation items", () => {
    const results = scanSyntheticAdapterSources({
      "fg.ts": `export const item = { type: "delegation", childRef: "c1", label: "fg", background: false };`,
      "bg-del.ts": `export const item = { type: "delegation", childRef: "c1", label: "bg", background: true };`,
      "shorthand-del.ts": `export function make(background: boolean) { return { type: "delegation", childRef: "c1", label: "bg", background }; }`,
      "bg-task.ts": `export const item = { type: "backgroundTask", familyId: "f1" };`,
      "union-bg-task.ts": `export function make(itemKind: "backgroundTask" | "command") { return { type: itemKind, familyId: "f1" }; }`,
      "union-bg-del.ts": `export function make(itemKind: "delegation" | "command") { return { type: itemKind, childRef: "c1", label: "bg", background: true }; }`,
      "spread-override-del.ts": `export function make(extra: { background?: boolean }) { return { type: "delegation", childRef: "c1", label: "bg", background: false, ...extra }; }`,
    });

    expect(assertCertifiedBackgroundScopedItems(results["fg.ts"]!)).toEqual([]);
    expect(assertCertifiedBackgroundScopedItems(results["bg-del.ts"]!)).toEqual([
      "delegation",
    ]);
    expect(
      assertCertifiedBackgroundScopedItems(results["shorthand-del.ts"]!),
    ).toEqual(["delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["bg-task.ts"]!),
    ).toEqual(["backgroundTask"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["union-bg-task.ts"]!),
    ).toEqual(["backgroundTask"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["union-bg-del.ts"]!),
    ).toEqual(["delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["spread-override-del.ts"]!),
    ).toEqual(["delegation"]);
  });

  it("fails closed when an adapter emits a dynamic-kind item with an unresolved discriminator", () => {
    const results = scanSyntheticAdapterSources({
      "dyn-bg-task.ts": `export function make(itemKind: string) { return { type: itemKind, familyId: "f1", taskStatus: "pending" }; }`,
      "dyn-delegation.ts": `export function make(itemKind: string) { return { type: itemKind, childRef: "c1", label: "bg", background: true }; }`,
      "dyn-bare.ts": `export function make(itemKind: string) { return { type: itemKind }; }`,
      "spread-after-type.ts": `export function make(extra: Record<string, unknown>) { return { type: "command", ...extra }; }`,
      "unsafe-cast.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(raw: Record<string, unknown>): DeltaItemShape {
  return raw as unknown as DeltaItemShape;
}`,
      "unrelated-blob.ts": `export function make(mimeType: string): BlobPropertyBag { return { type: mimeType }; }`,
    });

    expect(results["dyn-bg-task.ts"]!.unresolvedItemTypes).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(results["dyn-bg-task.ts"]!),
    ).toThrow(/unresolved item type/);

    expect(results["dyn-delegation.ts"]!.unresolvedItemTypes).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(results["dyn-delegation.ts"]!),
    ).toThrow(/unresolved item type/);

    expect(results["dyn-bare.ts"]!.unresolvedItemTypes).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(results["dyn-bare.ts"]!),
    ).toThrow(/unresolved item type/);

    expect(results["spread-after-type.ts"]!.unresolvedItemTypes).toHaveLength(
      1,
    );
    expect(() =>
      assertCertifiedBackgroundScopedItems(results["spread-after-type.ts"]!),
    ).toThrow(/spread after type with unresolved item type/);

    expect(results["unsafe-cast.ts"]!.unresolvedItemTypes).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(results["unsafe-cast.ts"]!),
    ).toThrow(/unsafe type assertion to DeltaItemShape/);

    expect(
      assertCertifiedBackgroundScopedItems(results["unrelated-blob.ts"]!),
    ).toEqual([]);
  });

  it("only assumes 0 open background work for legacy codex, acp, and pi workers", () => {
    expect(legacyWorkerAssumesZeroOpenBackgroundWork("provider-codex")).toBe(
      true,
    );
    expect(legacyWorkerAssumesZeroOpenBackgroundWork("provider-acp")).toBe(
      true,
    );
    expect(legacyWorkerAssumesZeroOpenBackgroundWork("provider-pi")).toBe(true);
    expect(
      legacyWorkerAssumesZeroOpenBackgroundWork("provider-claude-code"),
    ).toBe(false);
    expect(
      legacyWorkerAssumesZeroOpenBackgroundWork("provider-scripted-echo"),
    ).toBe(false);
  });
});
