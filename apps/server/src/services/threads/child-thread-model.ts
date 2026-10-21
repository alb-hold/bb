import type { CallerExecutionInputSource } from "@bb/domain";
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
    source: CallerExecutionInputSource | undefined;
  },
): Promise<void> {
  await deps.providerRegistry.whenRegistrationsSettled();
  if (args.childScope === null || args.model == null) return;
  if (args.source !== undefined && args.source !== "explicit") return;
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
