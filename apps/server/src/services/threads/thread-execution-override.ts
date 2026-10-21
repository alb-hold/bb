import {
  type DbQueryConnection,
  getProjectExecutionDefaults,
  getThread,
  getThreadExecutionOverride,
  getThreadSpawner,
  isNativeTerminalThread,
  setThreadExecutionOverride,
  type ThreadExecutionOverride,
} from "@bb/db";
import {
  reconcileReasoningLevel,
  type AvailableModel,
  type CallerExecutionInputSource,
  type ReasoningLevel,
  type Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { resolveSystemExecutionOptionsForValidation } from "../system/execution-options.js";
import { getLastExecutionOptions } from "./thread-events.js";
import { getSupportedReasoningLevelsForProvider } from "./thread-reasoning-policy.js";
import {
  assertRequestedModelAllowedForCurrentScope,
  childThreadModel,
} from "./child-thread-model.js";

interface ThreadExecutionOverridePatch {
  model?: string | null;
  reasoningLevel?: ReasoningLevel | null;
}

interface ResolveThreadExecutionOverrideUpdateArgs {
  existing: ThreadExecutionOverride;
  patch: ThreadExecutionOverridePatch;
  models: readonly AvailableModel[];
  providerId: string;
  fallbackModel: string | null;
}

interface ApplyThreadExecutionOverrideArgs {
  thread: Thread;
  patch: ThreadExecutionOverridePatch;
}

interface RecoverThreadModelOverrideArgs {
  model: string | undefined;
  modelSource: CallerExecutionInputSource | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  reasoningLevelSource: CallerExecutionInputSource | undefined;
  thread: Thread;
}

export interface PreparedThreadModelOverrideRecovery {
  model: string | undefined;
  modelSource: CallerExecutionInputSource | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  reasoningLevelSource: CallerExecutionInputSource | undefined;
  models: readonly AvailableModel[];
  fallbackModel: string | null;
  spawnerThreadId: string | null;
}

export async function prepareThreadModelOverrideRecovery(
  deps: LoggedWorkSessionDeps,
  args: RecoverThreadModelOverrideArgs,
): Promise<PreparedThreadModelOverrideRecovery | null> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const existing = getThreadExecutionOverride(deps.db, args.thread.id);
  if (
    existing?.modelOverride == null &&
    existing?.reasoningLevelOverride == null
  ) {
    return null;
  }
  if (
    (args.model === undefined || args.modelSource !== "explicit") &&
    (args.reasoningLevel === undefined ||
      args.reasoningLevelSource !== "explicit")
  ) {
    return null;
  }
  const models = await loadThreadProviderModels(
    deps,
    args.thread,
    args.modelSource === "explicit" ? (args.model ?? null) : null,
  );
  return {
    ...args,
    models,
    fallbackModel: resolveFallbackModel(deps, args.thread),
    spawnerThreadId: getThreadSpawner(deps.db, args.thread.id),
  };
}

export function applyPreparedThreadModelOverrideRecovery(
  db: DbQueryConnection,
  registry: ProviderRegistryService,
  thread: Thread,
  prepared: PreparedThreadModelOverrideRecovery | null,
): void {
  if (prepared === null) return;
  const existing = getThreadExecutionOverride(db, thread.id);
  if (existing === null) return;
  const requiredChildModel = childThreadModel({
    parentThreadId: thread.parentThreadId ?? prepared.spawnerThreadId,
    declaredChildModel: registry.get(thread.providerId)?.childThreadModel,
  });
  const patch: ThreadExecutionOverridePatch = {};
  if (
    prepared.model !== undefined &&
    prepared.modelSource === "explicit" &&
    (requiredChildModel === null || prepared.model === requiredChildModel) &&
    existing.modelOverride != null &&
    existing.modelOverride !== prepared.model
  ) {
    patch.model = prepared.model;
  }
  if (
    prepared.reasoningLevel !== undefined &&
    prepared.reasoningLevelSource === "explicit" &&
    existing.reasoningLevelOverride != null &&
    existing.reasoningLevelOverride !== prepared.reasoningLevel
  ) {
    patch.reasoningLevel = prepared.reasoningLevel;
  }
  if (patch.model === undefined && patch.reasoningLevel === undefined) return;
  const next = resolveThreadExecutionOverrideUpdate(registry, {
    existing,
    patch,
    models: prepared.models,
    providerId: thread.providerId,
    fallbackModel: prepared.fallbackModel,
  });
  setThreadExecutionOverride(db, {
    threadId: thread.id,
    modelOverride: next.modelOverride,
    reasoningLevelOverride: next.reasoningLevelOverride,
  });
}

export function resolveThreadExecutionOverrideUpdate(
  registry: ProviderRegistryService,
  args: ResolveThreadExecutionOverrideUpdateArgs,
): ThreadExecutionOverride {
  const { existing, patch, models, providerId, fallbackModel } = args;

  const modelChanged = "model" in patch;
  let nextModel = existing.modelOverride;
  if (modelChanged) {
    if (patch.model === null || patch.model === undefined) {
      nextModel = null;
    } else {
      const target = models.find(
        (candidate) => candidate.model === patch.model,
      );
      if (!target) {
        throw new ApiError(
          400,
          "invalid_request",
          `Model "${patch.model}" is not available in this thread's ${providerId} model catalog. Choose a model offered by ${providerId}; changing providers requires starting a new thread.`,
        );
      }
      nextModel = patch.model;
    }
  }

  const effectiveModel = nextModel ?? fallbackModel;
  const effectiveModelEntry = effectiveModel
    ? models.find((candidate) => candidate.model === effectiveModel)
    : undefined;
  const supportedReasoning: readonly ReasoningLevel[] = effectiveModelEntry
    ? effectiveModelEntry.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      )
    : getSupportedReasoningLevelsForProvider(registry, providerId);

  let nextReasoning = existing.reasoningLevelOverride;
  if ("reasoningLevel" in patch) {
    if (patch.reasoningLevel === null || patch.reasoningLevel === undefined) {
      nextReasoning = null;
    } else {
      if (
        supportedReasoning.length > 0 &&
        !supportedReasoning.includes(patch.reasoningLevel)
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          `Reasoning level "${patch.reasoningLevel}" is not supported by ${
            effectiveModel
              ? `model "${effectiveModel}"`
              : `provider ${providerId}`
          }. Supported reasoning levels: ${supportedReasoning.join(", ")}.`,
        );
      }
      nextReasoning = patch.reasoningLevel;
    }
  } else if (
    nextReasoning !== null &&
    supportedReasoning.length > 0 &&
    !supportedReasoning.includes(nextReasoning)
  ) {
    nextReasoning = reconcileReasoningLevel(
      nextReasoning,
      supportedReasoning,
      effectiveModelEntry?.defaultReasoningEffort,
    );
  }

  return { modelOverride: nextModel, reasoningLevelOverride: nextReasoning };
}

export async function applyThreadExecutionOverride(
  deps: LoggedWorkSessionDeps,
  args: ApplyThreadExecutionOverrideArgs,
): Promise<void> {
  const { thread, patch } = args;

  const models = await loadThreadProviderModels(
    deps,
    thread,
    typeof patch.model === "string" ? patch.model : null,
  );
  deps.db.transaction(
    (tx) => {
      const currentThread = getThread(tx, thread.id);
      if (!currentThread) {
        throw new ApiError(404, "thread_not_found", "Thread not found");
      }
      if (
        typeof patch.model === "string" &&
        !isNativeTerminalThread(tx, thread.id)
      ) {
        assertRequestedModelAllowedForCurrentScope(
          { db: tx, providerRegistry: deps.providerRegistry },
          {
            threadId: thread.id,
            model: patch.model,
            providerId: currentThread.providerId,
            sources: undefined,
            spawnerThreadId: getThreadSpawner(deps.db, thread.id),
          },
        );
      }
      const existing = getThreadExecutionOverride(tx, thread.id) ?? {
        modelOverride: null,
        reasoningLevelOverride: null,
      };
      const next = resolveThreadExecutionOverrideUpdate(deps.providerRegistry, {
        existing,
        patch,
        models,
        providerId: currentThread.providerId,
        fallbackModel: resolveFallbackModel(deps, currentThread),
      });
      setThreadExecutionOverride(tx, {
        threadId: thread.id,
        modelOverride: next.modelOverride,
        reasoningLevelOverride: next.reasoningLevelOverride,
      });
    },
    { behavior: "immediate" },
  );
}

export async function recoverThreadModelOverride(
  deps: LoggedWorkSessionDeps,
  args: RecoverThreadModelOverrideArgs,
): Promise<void> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const existing = getThreadExecutionOverride(deps.db, args.thread.id);
  const requiredChildModel = childThreadModel({
    parentThreadId:
      args.thread.parentThreadId ?? getThreadSpawner(deps.db, args.thread.id),
    declaredChildModel: deps.providerRegistry.get(args.thread.providerId)
      ?.childThreadModel,
  });
  const patch: ThreadExecutionOverridePatch = {};
  if (
    args.model !== undefined &&
    args.modelSource === "explicit" &&
    (requiredChildModel === null || args.model === requiredChildModel) &&
    existing?.modelOverride != null &&
    existing.modelOverride !== args.model
  ) {
    patch.model = args.model;
  }
  if (
    args.reasoningLevel !== undefined &&
    args.reasoningLevelSource === "explicit" &&
    existing?.reasoningLevelOverride != null &&
    existing.reasoningLevelOverride !== args.reasoningLevel
  ) {
    patch.reasoningLevel = args.reasoningLevel;
  }
  if (patch.model === undefined && patch.reasoningLevel === undefined) return;

  await applyThreadExecutionOverride(deps, {
    thread: args.thread,
    patch,
  });
}

export async function loadThreadProviderModels(
  deps: LoggedWorkSessionDeps,
  thread: Thread,
  requiredModel: string | null,
): Promise<readonly AvailableModel[]> {
  const result = await resolveSystemExecutionOptionsForValidation(
    deps,
    {
      providerId: thread.providerId,
      ...(thread.environmentId !== null
        ? { environmentId: thread.environmentId }
        : {}),
    },
    requiredModel,
  );
  if (result.modelLoadError !== null) {
    throw new ApiError(
      503,
      "model_catalog_unavailable",
      `Unable to load ${thread.providerId} models to validate the change. Try again once the host is connected.`,
    );
  }
  return [...result.models, ...result.selectedOnlyModels];
}

export function resolveFallbackModel(
  deps: Pick<LoggedWorkSessionDeps, "db">,
  thread: Thread,
): string | null {
  const lastExecution = getLastExecutionOptions(deps, thread.id);
  if (lastExecution?.model) {
    return lastExecution.model;
  }
  const projectDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: thread.projectId,
    providerId: thread.providerId,
  });
  return projectDefaults?.model ?? null;
}
