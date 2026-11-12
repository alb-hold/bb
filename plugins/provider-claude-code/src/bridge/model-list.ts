import fs from "node:fs/promises";
import path from "node:path";
import { type AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildClaudeCodeModels } from "../model-list.js";
import { afterClaudeRenewalSettles } from "./claude-refresh-lock.js";
import { probeClaudeInitialization } from "./initialization-probe.js";

const CLAUDE_MODELS_URL_ENV = "BB_CLAUDE_MODELS_URL";
const CLAUDE_MODELS_TIMEOUT_MS = 10_000;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const supportedSchema = z.object({ supported: z.boolean() }).optional();
const claudeModelPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      display_name: z.string(),
      capabilities: z
        .object({
          effort: z
            .object({
              low: supportedSchema,
              medium: supportedSchema,
              high: supportedSchema,
              xhigh: supportedSchema,
              max: supportedSchema,
            })
            .nullish(),
        })
        .nullish(),
    }),
  ),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});

export async function listAccountModels(
  env: NodeJS.ProcessEnv,
): Promise<ModelInfo[] | null> {
  const endpoint = env[CLAUDE_MODELS_URL_ENV];
  const token = env.ANTHROPIC_AUTH_TOKEN;
  if (!endpoint || !token) {
    return null;
  }
  const models: ModelInfo[] = [];
  const signal = AbortSignal.timeout(CLAUDE_MODELS_TIMEOUT_MS);
  const url = new URL(endpoint);
  url.searchParams.set("limit", "1000");
  while (true) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      signal,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Listing Claude models from ${url.origin}${url.pathname} failed with HTTP ${response.status}.`,
      );
    }
    const page = claudeModelPageSchema.parse(await response.json());
    for (const model of page.data) {
      models.push({
        value: model.id,
        displayName: model.display_name,
        description: model.display_name,
        supportedEffortLevels: EFFORT_LEVELS.filter(
          (level) => model.capabilities?.effort?.[level]?.supported === true,
        ),
      });
    }
    if (
      !page.has_more ||
      page.last_id === null ||
      page.last_id === url.searchParams.get("after_id")
    ) {
      if (models.length === 0) {
        throw new Error(
          `Listing Claude models from ${url.origin}${url.pathname} returned no models.`,
        );
      }
      return models;
    }
    url.searchParams.set("after_id", page.last_id);
  }
}

export function preferAccountModels(
  cliModels: readonly ModelInfo[],
  accountModels: readonly ModelInfo[],
): ModelInfo[] {
  const available = new Set(accountModels.map((model) => model.value));
  const defaultModel = cliModels.find(
    (model) => model.value === "default",
  )?.resolvedModel;
  const descriptions = new Map(
    cliModels
      .filter((model) => model.value !== "default")
      .map((model) => [model.resolvedModel ?? model.value, model.description]),
  );
  const rows = accountModels.map((model) => ({
    ...model,
    description: descriptions.get(model.value) ?? model.description,
  }));
  return [
    ...rows.filter((model) => model.value === defaultModel),
    ...rows.filter((model) => model.value !== defaultModel),
    ...cliModels.filter((model) =>
      available.has(model.resolvedModel ?? model.value),
    ),
  ];
}

export async function probeClaudeCodeDiscoveredModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelInfo[]> {
  const initialization = await probeClaudeInitialization({
    env,
    cwd: process.cwd(),
  }).catch((error) => {
    if (
      env.ANTHROPIC_MODEL &&
      error instanceof Error &&
      error.message.includes("--client-data-url:") &&
      error.message.includes("pass the matching --model")
    )
      return probeClaudeInitialization({
        env: { ...env, ANTHROPIC_MODEL: undefined },
        cwd: process.cwd(),
      });
    throw error;
  });
  await afterClaudeRenewalSettles(env);
  if (initialization.models.length === 0) {
    throw new Error("Claude Code reported no models.");
  }
  const accountModels = await listAccountModels(env);
  return accountModels === null
    ? initialization.models
    : preferAccountModels(initialization.models, accountModels);
}

export async function listClaudeCodeBridgeModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ models: AvailableModel[]; selectedOnlyModels: AvailableModel[] }> {
  try {
    return buildClaudeCodeModels(await probeClaudeCodeDiscoveredModels(env));
  } catch (error) {
    if (
      env.ANTHROPIC_MODEL &&
      error instanceof Error &&
      error.message.includes("--client-data-url:") &&
      error.message.includes("pass the matching --model")
    ) {
      return buildClaudeCodeModels(
        await probeClaudeCodeDiscoveredModels({
          ...env,
          ANTHROPIC_MODEL: undefined,
        }),
      );
    }
    throw error;
  }
}

type ClaudeCodeModelCatalog = Awaited<
  ReturnType<typeof listClaudeCodeBridgeModels>
>;

const sharedCatalogEntrySchema = z.object({
  savedAt: z.number(),
  discoveredModels: z.array(
    z.object({
      value: z.string(),
      resolvedModel: z.string().optional(),
      displayName: z.string(),
      description: z.string(),
      supportedEffortLevels: z
        .array(z.enum(["low", "medium", "high", "xhigh", "max"]))
        .optional(),
    }),
  ),
});

export type SharedClaudeCodeModelCatalogEntry = z.infer<
  typeof sharedCatalogEntrySchema
>;

export interface SharedClaudeCodeModelCatalog {
  read: () => Promise<SharedClaudeCodeModelCatalogEntry | null>;
  write: (entry: SharedClaudeCodeModelCatalogEntry) => Promise<void>;
}

export const UNSHARED_CLAUDE_CODE_MODEL_CATALOG: SharedClaudeCodeModelCatalog =
  {
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
  };

export function createSharedClaudeCodeModelCatalogFile(
  filePath: string,
): SharedClaudeCodeModelCatalog {
  return {
    read: async () => {
      try {
        const parsed = sharedCatalogEntrySchema.safeParse(
          JSON.parse(await fs.readFile(filePath, "utf8")),
        );
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write: async (entry) => {
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporaryPath, JSON.stringify(entry), "utf8");
      await fs.rename(temporaryPath, filePath);
    },
  };
}

interface ClaudeCodeBridgeModelListMemoOptions {
  probe: (envVars: Readonly<Record<string, string>>) => Promise<ModelInfo[]>;
  now: () => number;
  ttlMs: number;
  shared: () => SharedClaudeCodeModelCatalog;
  renewalDue: () => Promise<boolean>;
}

export function createClaudeCodeBridgeModelListMemo({
  probe,
  now,
  ttlMs,
  shared,
  renewalDue,
}: ClaudeCodeBridgeModelListMemoOptions): (
  envVars?: Readonly<Record<string, string>>,
) => Promise<ClaudeCodeModelCatalog> {
  const scopes = new Map<
    string,
    { resolve: () => Promise<ClaudeCodeModelCatalog>; expiresAt: number }
  >();
  const pendingScopes = new Set<string>();
  const createScope = (
    envVars: Readonly<Record<string, string>>,
    scoped: boolean,
  ) => {
    let settled: SharedClaudeCodeModelCatalogEntry | null = null;
    let pending: Promise<ClaudeCodeModelCatalog> | null = null;
    const isFresh = (entry: SharedClaudeCodeModelCatalogEntry) =>
      entry.savedAt + ttlMs > now();
    const resolveCatalog = async (): Promise<ClaudeCodeModelCatalog> => {
      const cache = scoped ? UNSHARED_CLAUDE_CODE_MODEL_CATALOG : shared();
      const stored = await cache.read();
      if (stored !== null && isFresh(stored)) {
        settled = stored;
        return buildClaudeCodeModels(stored.discoveredModels);
      }
      if (!scoped && (await renewalDue())) {
        const lastGood =
          settled !== null &&
          (stored === null || settled.savedAt >= stored.savedAt)
            ? settled
            : stored;
        return buildClaudeCodeModels(lastGood?.discoveredModels ?? []);
      }
      const entry = { savedAt: now(), discoveredModels: await probe(envVars) };
      settled = entry;
      await cache.write(entry).catch(() => undefined);
      return buildClaudeCodeModels(entry.discoveredModels);
    };
    return () => {
      if (settled !== null && isFresh(settled)) {
        return Promise.resolve(buildClaudeCodeModels(settled.discoveredModels));
      }
      if (pending !== null) {
        return pending;
      }
      const resolving = resolveCatalog().finally(() => {
        if (pending === resolving) {
          pending = null;
        }
      });
      pending = resolving;
      return resolving;
    };
  };
  return (envVars = {}) => {
    const key = JSON.stringify(
      Object.entries(envVars).sort(([a], [b]) => a.localeCompare(b)),
    );
    for (const [scopeKey, scope] of scopes)
      if (scope.expiresAt <= now() && !pendingScopes.has(scopeKey))
        scopes.delete(scopeKey);
    let scope = scopes.get(key);
    if (scope === undefined) {
      scope = {
        resolve: createScope(envVars, Object.keys(envVars).length > 0),
        expiresAt: now() + ttlMs,
      };
      scopes.set(key, scope);
    }
    scope.expiresAt = now() + ttlMs;
    pendingScopes.add(key);
    return scope.resolve().finally(() => pendingScopes.delete(key));
  };
}
