import { z } from "zod";
import type { PluginHookSignatures } from "@get-bb/plugin-sdk";
import { pluginHookProvider } from "../plugins/plugin-hook-registry.js";
import { decideWithinBox } from "./dispatch-hooks.js";

type RouteContext =
  PluginHookSignatures["experimental_thread.route"]["context"];

export const THREAD_ROUTE_HOOK_TIMEOUT_MS = 2_000;
export const THREAD_ROUTE_INPUT_TEXT_MAX_LENGTH = 4_000;

const routeDecisionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().nullable().optional(),
    reason: z.string().optional(),
  })
  .nullable();

export interface ThreadRouteDecision {
  pluginId: string;
  providerId: string;
  model: string | null;
  reason: string | null;
}

export interface ThreadRouteOutcome {
  decision: ThreadRouteDecision | null;
  failures: string[];
}

export async function runThreadRouteHooks(
  context: RouteContext,
): Promise<ThreadRouteOutcome> {
  const provider = pluginHookProvider();
  const failures: string[] = [];
  if (provider === undefined) return { decision: null, failures };
  for (const hook of provider.listHooks("experimental_thread.route")) {
    const invocation = await provider.invokeHook(hook, "thread route", () =>
      decideWithinBox(
        async () => hook.handler(context),
        Math.min(provider.decisionTimeoutMs, THREAD_ROUTE_HOOK_TIMEOUT_MS),
      ),
    );
    if (!invocation.ok) {
      failures.push(`${hook.pluginId}: ${invocation.error}`);
      continue;
    }
    if (!invocation.value.ok) {
      failures.push(`${hook.pluginId}: ${invocation.value.error}`);
      continue;
    }
    const parsed = routeDecisionSchema.safeParse(invocation.value.value);
    if (!parsed.success) {
      failures.push(`${hook.pluginId}: returned an invalid decision`);
      continue;
    }
    if (parsed.data === null) continue;
    return {
      decision: {
        pluginId: hook.pluginId,
        providerId: parsed.data.providerId,
        model: parsed.data.model ?? null,
        reason: parsed.data.reason ?? null,
      },
      failures,
    };
  }
  return { decision: null, failures };
}
