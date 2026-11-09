import type { ExistingThreadExecutionInputSources } from "@bb/server-contract";
import {
  getThread,
  getThreadSpawner,
  getThreadExecutionOverride,
  type DbQueryConnection,
} from "@bb/db";
import { ApiError } from "../../errors.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";

interface ChildThreadModelArgs {
  parentThreadId: string | null | undefined;
  declaredChildModel: string | null | undefined;
}

export function childThreadModel(args: ChildThreadModelArgs): string | null {
  if (!args.parentThreadId) {
    return null;
  }
  return args.declaredChildModel ?? null;
}

interface ChildModelDeps {
  db: DbQueryConnection;
  providerRegistry: ProviderRegistryService;
}

interface RequestedModelArgs {
  threadId: string;
  model: string | null | undefined;
  providerId: string;
  sources: ExistingThreadExecutionInputSources | undefined;
}

function assertChildModelAllowed(
  deps: ChildModelDeps,
  args: RequestedModelArgs & { childScope: "parent" | "spawner" | null },
): void {
  if (args.childScope === null || args.model == null) return;
  const source = args.sources === undefined ? "explicit" : args.sources.model;
  if (source !== "explicit") return;
  const requiredModel =
    deps.providerRegistry.get(args.providerId)?.childThreadModel ?? null;
  const persistedModel =
    getThreadExecutionOverride(deps.db, args.threadId)?.modelOverride ?? null;
  if (
    requiredModel === null ||
    args.model === requiredModel ||
    args.model === persistedModel
  )
    return;
  const allowedModels =
    persistedModel === null || persistedModel === requiredModel
      ? requiredModel
      : `${requiredModel} or the persisted model ${persistedModel}`;
  throw new ApiError(
    400,
    "child_model_conflict",
    `Child threads for ${args.providerId} must use ${allowedModels}; omit the explicit model to keep the thread's selected model.`,
    {
      details: {
        providerId: args.providerId,
        requestedModel: args.model,
        childThreadModel: requiredModel,
        reason: args.childScope,
      },
    },
  );
}

export async function assertRequestedModelAllowed(
  deps: ChildModelDeps,
  args: RequestedModelArgs & { childScope: "parent" | "spawner" | null },
): Promise<void> {
  await deps.providerRegistry.whenRegistrationsSettled();
  assertChildModelAllowed(deps, args);
}

export function assertRequestedModelAllowedForCurrentScope(
  deps: ChildModelDeps,
  args: RequestedModelArgs & {
    spawnerThreadId?: string | null;
    expectedParentThreadId?: string | null;
  },
): void {
  const thread = getThread(deps.db, args.threadId);
  if (!thread) throw new ApiError(404, "thread_not_found", "Thread not found");
  if (
    args.expectedParentThreadId !== undefined &&
    thread.parentThreadId !== args.expectedParentThreadId
  ) {
    throw new ApiError(
      409,
      "thread_scope_changed",
      "Thread scope changed while this request was being prepared. Retry the request.",
    );
  }
  const spawnerThreadId =
    args.spawnerThreadId ??
    ("$client" in deps.db ? getThreadSpawner(deps.db, thread.id) : null);
  assertChildModelAllowed(deps, {
    ...args,
    childScope: thread.parentThreadId
      ? "parent"
      : spawnerThreadId === null
        ? null
        : "spawner",
  });
}
