import type { ExistingThreadExecutionInputSources } from "@bb/server-contract";
import { getThread, getThreadSpawner } from "@bb/db";
import type { DbQueryConnection } from "@bb/db";
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

export async function assertRequestedModelAllowed(
  deps: Pick<{ providerRegistry: ProviderRegistryService }, "providerRegistry">,
  args: {
    childScope: "parent" | "spawner" | null;
    model: string | null | undefined;
    providerId: string;
    sources: ExistingThreadExecutionInputSources | undefined;
  },
): Promise<void> {
  await deps.providerRegistry.whenRegistrationsSettled();
  if (args.childScope === null || args.model == null) return;
  const source = args.sources === undefined ? "explicit" : args.sources.model;
  if (source !== "explicit") return;
  const requiredModel = childThreadModel({
    parentThreadId: args.childScope === null ? null : "child",
    declaredChildModel: deps.providerRegistry.get(args.providerId)
      ?.childThreadModel,
  });
  if (requiredModel === null || args.model === requiredModel) return;
  const reason = args.childScope === "parent" ? "parent" : "spawner";
  throw new ApiError(
    400,
    "child_model_conflict",
    `Child threads for ${args.providerId} must use ${requiredModel}; omit the explicit model or request ${requiredModel}.`,
    {
      details: {
        providerId: args.providerId,
        requestedModel: args.model,
        childThreadModel: requiredModel,
        reason,
      },
    },
  );
}

export function assertRequestedModelAllowedForCurrentScope(
  deps: Pick<
    { db: DbQueryConnection; providerRegistry: ProviderRegistryService },
    "db" | "providerRegistry"
  >,
  args: {
    threadId: string;
    model: string | null | undefined;
    providerId: string;
    sources: ExistingThreadExecutionInputSources | undefined;
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
  const childScope = thread.parentThreadId
    ? "parent"
    : spawnerThreadId === null
      ? null
      : "spawner";
  if (childScope === null || args.model == null) return;
  const source = args.sources === undefined ? "explicit" : args.sources.model;
  if (source !== "explicit") return;
  const requiredModel =
    deps.providerRegistry.get(args.providerId)?.childThreadModel ?? null;
  if (requiredModel === null || args.model === requiredModel) return;
  const reason = childScope === "parent" ? "parent" : "spawner";
  throw new ApiError(
    400,
    "child_model_conflict",
    `Child threads for ${args.providerId} must use ${requiredModel}; omit the explicit model or request ${requiredModel}.`,
    {
      details: {
        providerId: args.providerId,
        requestedModel: args.model,
        childThreadModel: requiredModel,
        reason,
      },
    },
  );
}
