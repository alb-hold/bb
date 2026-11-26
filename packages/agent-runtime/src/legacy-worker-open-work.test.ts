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

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteralValue(expr: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expr);
  if (
    ts.isStringLiteral(unwrapped) ||
    ts.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return unwrapped.text;
  }
  return null;
}

export function scanSourceForBackgroundScopedItems(
  fileName: string,
  sourceText: string,
): Set<BackgroundScopedItemKind> {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const discovered = new Set<BackgroundScopedItemKind>();

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let itemType: string | null = null;
      let backgroundProp: ts.Expression | undefined;
      let hasBackgroundShorthand = false;

      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const propName = propertyNameText(prop.name);
          if (propName === "type") {
            itemType = stringLiteralValue(prop.initializer);
          } else if (propName === "background") {
            backgroundProp = unwrapExpression(prop.initializer);
          }
        } else if (
          ts.isShorthandPropertyAssignment(prop) &&
          prop.name.text === "background"
        ) {
          hasBackgroundShorthand = true;
        }
      }

      if (itemType === "backgroundTask") {
        discovered.add("backgroundTask");
      } else if (itemType === "delegation") {
        const explicitlyForeground =
          !hasBackgroundShorthand &&
          backgroundProp !== undefined &&
          backgroundProp.kind === ts.SyntaxKind.FalseKeyword;
        if (!explicitlyForeground) {
          discovered.add("delegation");
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return discovered;
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

  it("matches the background-scoped delta items actually emitted by each adapter", () => {
    const actual: Record<string, BackgroundScopedItemKind[]> = {};

    for (const [pluginId, roots] of Object.entries(
      PLUGIN_ADAPTER_SOURCE_ROOTS,
    )) {
      const kinds = new Set<BackgroundScopedItemKind>();
      const files = roots.flatMap((root) => collectAdapterSourceFiles(root));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        for (const kind of scanSourceForBackgroundScopedItems(
          file,
          readFileSync(file, "utf8"),
        )) {
          kinds.add(kind);
        }
      }
      actual[pluginId] = [...kinds].sort();
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
  });

  it("detects backgroundTask and non-false delegation literals when an adapter starts emitting them", () => {
    expect([
      ...scanSourceForBackgroundScopedItems(
        "fg.ts",
        `const item = { type: "delegation", childRef: "c1", label: "fg", background: false };`,
      ),
    ]).toEqual([]);
    expect([
      ...scanSourceForBackgroundScopedItems(
        "bg-del.ts",
        `const item = { type: "delegation", childRef: "c1", label: "bg", background: true };`,
      ),
    ]).toEqual(["delegation"]);
    expect([
      ...scanSourceForBackgroundScopedItems(
        "dyn-del.ts",
        `const background = true; const item = { type: "delegation", childRef: "c1", label: "bg", background };`,
      ),
    ]).toEqual(["delegation"]);
    expect([
      ...scanSourceForBackgroundScopedItems(
        "bg-task.ts",
        `const item = { type: "backgroundTask", familyId: "f1" };`,
      ),
    ]).toEqual(["backgroundTask"]);
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
