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

const ITEM_DELTA_KINDS = new Set(["item.open", "item.progress", "item.close"]);

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
  return {
    ...parsed.options,
    customConditions: [
      ...new Set([...(parsed.options.customConditions ?? []), "source"]),
    ],
  };
}

function getProtocolDeclaredType(
  program: ts.Program,
  checker: ts.TypeChecker,
  typeName: string,
): ts.Type {
  const protocolFile = program.getSourceFile(PROTOCOL_THREAD_DELTA_PATH);
  if (protocolFile === undefined) {
    throw new Error(`Missing protocol source file: ${PROTOCOL_THREAD_DELTA_PATH}`);
  }
  for (const statement of protocolFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === typeName
    ) {
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol !== undefined) {
        return checker.getDeclaredTypeOfSymbol(symbol);
      }
    }
  }
  throw new Error(`${typeName} not found in thread-delta.ts`);
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

function isUninhabitedType(checker: ts.TypeChecker, part: ts.Type): boolean {
  if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return false;
  }
  if ((part.flags & ts.TypeFlags.Never) !== 0) {
    return true;
  }
  return checker.isTypeAssignableTo(part, checker.getNeverType());
}

function isStrictlyLiteralFalseType(
  checker: ts.TypeChecker,
  targetType: ts.Type,
): boolean {
  if ((targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return false;
  }
  const parts = (
    targetType.isUnion() ? targetType.types : [targetType]
  ).filter((part) => !isUninhabitedType(checker, part));
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        (part.flags & ts.TypeFlags.BooleanLiteral) !== 0 &&
        checker.typeToString(part) === "false",
    )
  );
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
    if (isUninhabitedType(checker, part)) {
      return false;
    }
    if (checker.getIndexTypeOfType(part, ts.IndexKind.String) !== undefined) {
      return true;
    }
    return part.getProperty(propertyName) !== undefined;
  });
}

function hasUnsafeItemTypeConstituent(
  checker: ts.TypeChecker,
  expr: ts.Node,
  exprType: ts.Type,
): boolean {
  if ((exprType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return true;
  }
  const parts = exprType.isUnion() ? exprType.types : [exprType];
  const inhabitedParts = parts.filter(
    (part) => !isUninhabitedType(checker, part),
  );
  if (inhabitedParts.length === 0) {
    return true;
  }
  return inhabitedParts.some((part) => {
    if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return true;
    }
    const typeSymbol = part.getProperty("type");
    if (typeSymbol === undefined) {
      return true;
    }
    const typePropType = checker.getTypeOfSymbolAtLocation(typeSymbol, expr);
    const typeParts = (
      typePropType.isUnion() ? typePropType.types : [typePropType]
    ).filter((constituent) => !isUninhabitedType(checker, constituent));
    if (typeParts.length === 0) {
      return true;
    }
    return typeParts.some(
      (constituent) => (constituent.flags & ts.TypeFlags.StringLiteral) === 0,
    );
  });
}

function hasUnsafeThreadDeltaConstituent(
  checker: ts.TypeChecker,
  expr: ts.Node,
  exprType: ts.Type,
): boolean {
  if ((exprType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return true;
  }
  const parts = (exprType.isUnion() ? exprType.types : [exprType]).filter(
    (part) => !isUninhabitedType(checker, part),
  );
  if (parts.length === 0) {
    return true;
  }
  return parts.some((part) => {
    if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return true;
    }
    const elementType = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    if (elementType !== undefined) {
      return hasUnsafeThreadDeltaConstituent(checker, expr, elementType);
    }
    const kindSymbol = part.getProperty("kind");
    if (kindSymbol === undefined) {
      return true;
    }
    const kindType = checker.getTypeOfSymbolAtLocation(kindSymbol, expr);
    const kindParts = (
      kindType.isUnion() ? kindType.types : [kindType]
    ).filter((constituent) => !isUninhabitedType(checker, constituent));
    if (
      kindParts.length === 0 ||
      kindParts.some(
        (constituent) => (constituent.flags & ts.TypeFlags.StringLiteral) === 0,
      )
    ) {
      return true;
    }
    const includesItemDelta = kindParts.some((constituent) =>
      ITEM_DELTA_KINDS.has((constituent as ts.StringLiteralType).value),
    );
    if (!includesItemDelta) {
      return false;
    }
    const itemSymbol = part.getProperty("item");
    if (itemSymbol === undefined) {
      return true;
    }
    return hasUnsafeItemTypeConstituent(
      checker,
      expr,
      checker.getTypeOfSymbolAtLocation(itemSymbol, expr),
    );
  });
}

function recordScopedKindsFromTypedValue(
  checker: ts.TypeChecker,
  locationExpr: ts.Node,
  valueType: ts.Type,
  discovered: Set<BackgroundScopedItemKind>,
  options?: {
    overrideBackgroundFalse?: boolean;
    overrideBackgroundDynamic?: boolean;
  },
): void {
  const inhabitedParts = (
    valueType.isUnion() ? valueType.types : [valueType]
  ).filter(
    (part) =>
      !isUninhabitedType(checker, part) &&
      (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0,
  );
  for (const part of inhabitedParts) {
    const typeSymbol = part.getProperty("type");
    if (typeSymbol === undefined) {
      continue;
    }
    const typePropType = checker.getTypeOfSymbolAtLocation(
      typeSymbol,
      locationExpr,
    );
    const typeParts = (
      typePropType.isUnion() ? typePropType.types : [typePropType]
    ).filter((constituent) => !isUninhabitedType(checker, constituent));
    for (const constituent of typeParts) {
      if ((constituent.flags & ts.TypeFlags.StringLiteral) === 0) {
        continue;
      }
      const kind = (constituent as ts.StringLiteralType).value;
      if (kind === "backgroundTask") {
        discovered.add("backgroundTask");
      } else if (kind === "delegation") {
        if (options?.overrideBackgroundDynamic === true) {
          discovered.add("delegation");
          continue;
        }
        if (options?.overrideBackgroundFalse === true) {
          continue;
        }
        const bgSymbol = part.getProperty("background");
        const foreground =
          bgSymbol !== undefined &&
          isStrictlyLiteralFalseType(
            checker,
            checker.getTypeOfSymbolAtLocation(bgSymbol, locationExpr),
          );
        if (!foreground) {
          discovered.add("delegation");
        }
      }
    }
  }
}

function typeTargetsProtocolType(
  checker: ts.TypeChecker,
  candidateType: ts.Type,
  protocolType: ts.Type,
): boolean {
  const parts = candidateType.isUnion() ? candidateType.types : [candidateType];
  return parts.some((part) => {
    if (
      isUninhabitedType(checker, part) ||
      (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    ) {
      return false;
    }
    if (checker.isTypeAssignableTo(part, protocolType)) {
      return true;
    }
    const elem = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    return (
      elem !== undefined &&
      !isUninhabitedType(checker, elem) &&
      (elem.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
      checker.isTypeAssignableTo(elem, protocolType)
    );
  });
}

function analyzeSourceFileInProgram(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  deltaItemShapeType: ts.Type,
  threadDeltaType: ts.Type,
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

  const inspectReturnedItemExpression = (expr: ts.Expression): void => {
    if (ts.isObjectLiteralExpression(expr)) {
      return;
    }
    const exprType = checker.getTypeAtLocation(expr);
    const inhabitedParts = (
      exprType.isUnion() ? exprType.types : [exprType]
    ).filter((part) => !isUninhabitedType(checker, part));
    const returnsDeltaItem = inhabitedParts.some(
      (part) =>
        (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
        checker.isTypeAssignableTo(part, deltaItemShapeType),
    );
    if (!returnsDeltaItem) {
      return;
    }
    if (hasUnsafeItemTypeConstituent(checker, expr, exprType)) {
      unresolvedItemTypes.push(
        `${formatLocation(expr)} (returned DeltaItemShape with unresolved type)`,
      );
    }
    recordScopedKindsFromTypedValue(checker, expr, exprType, discovered);
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
        const explicitlyForeground =
          bgProp !== undefined &&
          !overriddenByLaterSpread &&
          isStrictlyLiteralFalseType(
            checker,
            typeOfObjectPropertyNode(checker, bgProp),
          );
        if (!explicitlyForeground) {
          discovered.add("delegation");
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      inspectReturnedItemExpression(node.expression);
    }

    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      inspectReturnedItemExpression(node.body);
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const targetType = checker.getTypeAtLocation(node);
      if (typeTargetsProtocolType(checker, targetType, deltaItemShapeType)) {
        const sourceType = checker.getTypeAtLocation(node.expression);
        if (hasUnsafeItemTypeConstituent(checker, node.expression, sourceType)) {
          unresolvedItemTypes.push(
            `${formatLocation(node)} (unsafe type assertion to DeltaItemShape)`,
          );
        }
      } else if (typeTargetsProtocolType(checker, targetType, threadDeltaType)) {
        const sourceType = checker.getTypeAtLocation(node.expression);
        if (
          hasUnsafeThreadDeltaConstituent(checker, node.expression, sourceType)
        ) {
          unresolvedItemTypes.push(
            `${formatLocation(node)} (unsafe type assertion to ThreadDelta)`,
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
      if (typeTargetsProtocolType(checker, returnType, deltaItemShapeType)) {
        unresolvedItemTypes.push(
          `${formatLocation(node)} (Object.assign producing DeltaItemShape)`,
        );
      } else if (typeTargetsProtocolType(checker, returnType, threadDeltaType)) {
        unresolvedItemTypes.push(
          `${formatLocation(node)} (Object.assign producing ThreadDelta)`,
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
      let kindProp:
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
        | undefined;
      let deltaItemProp:
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
        | undefined;
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
            if (propName === "kind") {
              kindProp = prop;
            }
            if (propName === "item") {
              deltaItemProp = prop;
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
                  0 && !isUninhabitedType(checker, part),
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

      if (kindProp !== undefined && deltaItemProp !== undefined) {
        const kindType = typeOfObjectPropertyNode(checker, kindProp);
        const kindParts = (
          kindType.isUnion() ? kindType.types : [kindType]
        ).filter((part) => !isUninhabitedType(checker, part));
        const isItemDelta = kindParts.some(
          (part) =>
            (part.flags & ts.TypeFlags.StringLiteral) !== 0 &&
            ITEM_DELTA_KINDS.has((part as ts.StringLiteralType).value),
        );
        if (isItemDelta) {
          const itemExpr = ts.isPropertyAssignment(deltaItemProp)
            ? deltaItemProp.initializer
            : deltaItemProp.name;
          const itemExprType = typeOfObjectPropertyNode(checker, deltaItemProp);
          if (hasUnsafeItemTypeConstituent(checker, itemExpr, itemExprType)) {
            unresolvedItemTypes.push(
              `${formatLocation(deltaItemProp)} (unresolved ThreadDelta item expression)`,
            );
          }
          recordScopedKindsFromTypedValue(
            checker,
            itemExpr,
            itemExprType,
            discovered,
          );
        }
      }

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

      const inspectSpread = (
        spread: { expr: ts.Expression; index: number },
        afterExplicitType: boolean,
      ): void => {
        const spreadType = checker.getTypeAtLocation(spread.expr);
        const inhabitedSpreadParts = (
          spreadType.isUnion() ? spreadType.types : [spreadType]
        ).filter((part) => !isUninhabitedType(checker, part));
        const spreadHasDeltaItemConstituent = inhabitedSpreadParts.some(
          (part) =>
            (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0 &&
            checker.isTypeAssignableTo(part, deltaItemShapeType),
        );

        if (hasUnsafeItemTypeConstituent(checker, spread.expr, spreadType)) {
          if (afterExplicitType) {
            if (
              hasBackgroundShapeField ||
              insideTypeAssertion ||
              contextCouldBeDeltaItem ||
              spreadHasDeltaItemConstituent
            ) {
              unresolvedItemTypes.push(
                `${formatLocation(spread.expr)} (spread after type with unresolved item type)`,
              );
            }
          } else if (
            hasBackgroundShapeField ||
            insideTypeAssertion ||
            contextAssignsToDeltaItem ||
            spreadHasDeltaItemConstituent
          ) {
            unresolvedItemTypes.push(
              `${formatLocation(spread.expr)} (spread with unresolved item type)`,
            );
          }
        }

        const overriddenAfterBg =
          bgProp !== undefined &&
          spreads.some(
            (other) =>
              other.index > bgPropIndex &&
              spreadCanSupplyProperty(checker, other.expr, "background"),
          );
        const overriddenAfterSpread = spreads.some(
          (other) =>
            other.index > spread.index &&
            spreadCanSupplyProperty(checker, other.expr, "background"),
        );

        let overrideBackgroundFalse = false;
        let overrideBackgroundDynamic = false;
        if (bgProp !== undefined && bgPropIndex > spread.index) {
          if (
            !overriddenAfterBg &&
            isStrictlyLiteralFalseType(
              checker,
              typeOfObjectPropertyNode(checker, bgProp),
            )
          ) {
            overrideBackgroundFalse = true;
          } else {
            overrideBackgroundDynamic = true;
          }
        } else if (overriddenAfterSpread) {
          overrideBackgroundDynamic = true;
        }

        recordScopedKindsFromTypedValue(
          checker,
          spread.expr,
          spreadType,
          discovered,
          {
            overrideBackgroundFalse,
            overrideBackgroundDynamic,
          },
        );
      };

      if (typeProp === undefined && spreads.length > 0) {
        for (const spread of spreads) {
          if (spreadCanSupplyProperty(checker, spread.expr, "type")) {
            inspectSpread(spread, false);
          } else if (
            contextAssignsToDeltaItem &&
            hasUnsafeItemTypeConstituent(
              checker,
              spread.expr,
              checker.getTypeAtLocation(spread.expr),
            )
          ) {
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
                inspectSpread(spread, true);
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
  const deltaItemShapeType = getProtocolDeclaredType(
    program,
    checker,
    "DeltaItemShape",
  );
  const threadDeltaType = getProtocolDeclaredType(
    program,
    checker,
    "ThreadDelta",
  );
  const targetSet = new Set(files);

  const kinds = new Set<BackgroundScopedItemKind>();
  const unresolvedItemTypes: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!targetSet.has(sourceFile.fileName)) continue;
    const result = analyzeSourceFileInProgram(
      sourceFile,
      checker,
      deltaItemShapeType,
      threadDeltaType,
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
  const deltaItemShapeType = getProtocolDeclaredType(
    program,
    checker,
    "DeltaItemShape",
  );
  const threadDeltaType = getProtocolDeclaredType(
    program,
    checker,
    "ThreadDelta",
  );

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
      threadDeltaType,
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
  }, 45_000);

  it("detects literal, union-typed, spread, and local-alias backgroundTask and delegation items", () => {
    const results = scanSyntheticAdapterSources({
      "fg.ts": `export const item = { type: "delegation", childRef: "c1", label: "fg", background: false };`,
      "bg-del.ts": `export const item = { type: "delegation", childRef: "c1", label: "bg", background: true };`,
      "shorthand-del.ts": `export function make(background: boolean) { return { type: "delegation", childRef: "c1", label: "bg", background }; }`,
      "bg-task.ts": `export const item = { type: "backgroundTask", familyId: "f1" };`,
      "union-bg-task.ts": `export function make(itemKind: "backgroundTask" | "command") { return { type: itemKind, familyId: "f1" }; }`,
      "union-bg-del.ts": `export function make(itemKind: "delegation" | "command") { return { type: itemKind, childRef: "c1", label: "bg", background: true }; }`,
      "spread-override-del.ts": `export function make(extra: { background?: boolean }) { return { type: "delegation", childRef: "c1", label: "bg", background: false, ...extra }; }`,
      "spread-full-delta-item.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: DeltaItemShape): DeltaItemShape {
  return { ...incoming };
}`,
      "spread-uncontextual-delta-item.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: DeltaItemShape) {
  return { ...incoming };
}`,
      "spread-union-bg-task.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: Extract<DeltaItemShape, { type: "backgroundTask" | "command" }>): DeltaItemShape {
  return { ...incoming };
}`,
      "spread-union-delegation.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: Extract<DeltaItemShape, { type: "delegation" | "command" }>): DeltaItemShape {
  return { ...incoming };
}`,
      "spread-fg-delegation.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
type FgDelegation = Omit<Extract<DeltaItemShape, { type: "delegation" }>, "background"> & { background: false };
export function make(incoming: FgDelegation): DeltaItemShape {
  return { ...incoming };
}`,
      "spread-forced-fg-delegation.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: Extract<DeltaItemShape, { type: "delegation" }>): DeltaItemShape {
  return { ...incoming, background: false };
}`,
      "param-passthrough-delta.ts": `import type { DeltaItemShape, ThreadDelta } from "@bb/provider-bridge-protocol";
export function make(item: DeltaItemShape): ThreadDelta {
  return { kind: "item.open", key: { providerItemId: "1" }, item };
}`,
      "local-alias-delta.ts": `import type { DeltaItemShape, ThreadDelta } from "@bb/provider-bridge-protocol";
export function make(incoming: DeltaItemShape): ThreadDelta {
  const item: DeltaItemShape = incoming;
  return { kind: "item.open", key: { providerItemId: "1" }, item };
}`,
      "let-alias-delta.ts": `import type { DeltaItemShape, ThreadDelta } from "@bb/provider-bridge-protocol";
export function make(incoming: DeltaItemShape): ThreadDelta {
  let item: DeltaItemShape = incoming;
  return { kind: "item.open", key: { providerItemId: "1" }, item };
}`,
      "map-lookup-delta.ts": `import type { DeltaItemShape, ThreadDelta } from "@bb/provider-bridge-protocol";
const cache = new Map<string, DeltaItemShape>();
export function make(id: string): ThreadDelta {
  const found = cache.get(id)!;
  return { kind: "item.open", key: { providerItemId: id }, item: found };
}`,
      "standalone-return-alias.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: DeltaItemShape): DeltaItemShape {
  const item: DeltaItemShape = incoming;
  return item;
}`,
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
    expect(
      assertCertifiedBackgroundScopedItems(
        results["spread-full-delta-item.ts"]!,
      ),
    ).toEqual(["backgroundTask", "delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(
        results["spread-uncontextual-delta-item.ts"]!,
      ),
    ).toEqual(["backgroundTask", "delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["spread-union-bg-task.ts"]!),
    ).toEqual(["backgroundTask"]);
    expect(
      assertCertifiedBackgroundScopedItems(
        results["spread-union-delegation.ts"]!,
      ),
    ).toEqual(["delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["spread-fg-delegation.ts"]!),
    ).toEqual([]);
    expect(
      assertCertifiedBackgroundScopedItems(
        results["spread-forced-fg-delegation.ts"]!,
      ),
    ).toEqual([]);
    expect(
      assertCertifiedBackgroundScopedItems(
        results["param-passthrough-delta.ts"]!,
      ),
    ).toEqual(["backgroundTask", "delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["local-alias-delta.ts"]!),
    ).toEqual(["backgroundTask", "delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["let-alias-delta.ts"]!),
    ).toEqual(["backgroundTask", "delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(results["map-lookup-delta.ts"]!),
    ).toEqual(["backgroundTask", "delegation"]);
    expect(
      assertCertifiedBackgroundScopedItems(
        results["standalone-return-alias.ts"]!,
      ),
    ).toEqual(["backgroundTask", "delegation"]);
  });

  it("fails closed when an adapter emits a dynamic-kind item with an unresolved discriminator", () => {
    const results = scanSyntheticAdapterSources({
      "dyn-bg-task.ts": `export function make(itemKind: string) { return { type: itemKind, familyId: "f1", taskStatus: "pending" }; }`,
      "dyn-delegation.ts": `export function make(itemKind: string) { return { type: itemKind, childRef: "c1", label: "bg", background: true }; }`,
      "dyn-bare.ts": `export function make(itemKind: string) { return { type: itemKind }; }`,
      "spread-after-type.ts": `export function make(extra: Record<string, unknown>) { return { type: "command", ...extra }; }`,
      "spread-mixed-unsafe-union.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(incoming: DeltaItemShape | { type: string }) {
  return { ...incoming };
}`,
      "unsafe-cast.ts": `import type { DeltaItemShape } from "@bb/provider-bridge-protocol";
export function make(raw: Record<string, unknown>): DeltaItemShape {
  return raw as unknown as DeltaItemShape;
}`,
      "unsafe-cast-thread-delta.ts": `import type { ThreadDelta } from "@bb/provider-bridge-protocol";
export function make(raw: Record<string, unknown>): ThreadDelta {
  return raw as unknown as ThreadDelta;
}`,
      "json-parse-delta-item.ts": `import type { ThreadDelta } from "@bb/provider-bridge-protocol";
export function make(raw: string): ThreadDelta {
  return { kind: "item.open", key: { providerItemId: "1" }, item: JSON.parse(raw) };
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

    expect(
      results["spread-mixed-unsafe-union.ts"]!.unresolvedItemTypes,
    ).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(
        results["spread-mixed-unsafe-union.ts"]!,
      ),
    ).toThrow(/spread with unresolved item type/);

    expect(results["unsafe-cast.ts"]!.unresolvedItemTypes).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(results["unsafe-cast.ts"]!),
    ).toThrow(/unsafe type assertion to DeltaItemShape/);

    expect(
      results["unsafe-cast-thread-delta.ts"]!.unresolvedItemTypes,
    ).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(
        results["unsafe-cast-thread-delta.ts"]!,
      ),
    ).toThrow(/unsafe type assertion to ThreadDelta/);

    expect(
      results["json-parse-delta-item.ts"]!.unresolvedItemTypes,
    ).toHaveLength(1);
    expect(() =>
      assertCertifiedBackgroundScopedItems(
        results["json-parse-delta-item.ts"]!,
      ),
    ).toThrow(/unresolved ThreadDelta item expression/);

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
