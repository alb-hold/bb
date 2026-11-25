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

export type ThreadRouteFailureKind =
  | "timeout"
  | "threw"
  | "invalid_decision"
  | "host_error";

export interface ThreadRouteFailure {
  pluginId: string;
  kind: ThreadRouteFailureKind;
  errorName: string | null;
}

export interface ThreadRouteOutcome {
  decision: ThreadRouteDecision | null;
  failures: ThreadRouteFailure[];
}

const SAFE_LOG_TOKEN = /^[a-z0-9_.:-]{1,64}$/i;

export function safeHookLogToken(value: string): string {
  return SAFE_LOG_TOKEN.test(value) ? value : `[redacted len=${value.length}]`;
}

type HandlerResult =
  | { threw: false; value: unknown }
  | { threw: true; errorName: string };

export async function runThreadRouteHooks(
  context: RouteContext,
): Promise<ThreadRouteOutcome> {
  const provider = pluginHookProvider();
  const failures: ThreadRouteFailure[] = [];
  if (provider === undefined) return { decision: null, failures };
  for (const hook of provider.listHooks("experimental_thread.route")) {
    const invocation = await provider.invokeHook(hook, "thread route", () =>
      decideWithinBox(
        async (): Promise<HandlerResult> => {
          try {
            return { threw: false, value: await hook.handler(context) };
          } catch (error) {
            return {
              threw: true,
              errorName: error instanceof Error ? error.name : "NonError",
            };
          }
        },
        Math.min(provider.decisionTimeoutMs, THREAD_ROUTE_HOOK_TIMEOUT_MS),
      ),
    );
    if (!invocation.ok) {
      failures.push({
        pluginId: hook.pluginId,
        kind: "host_error",
        errorName: null,
      });
      continue;
    }
    if (!invocation.value.ok) {
      failures.push({
        pluginId: hook.pluginId,
        kind: "timeout",
        errorName: null,
      });
      continue;
    }
    if (invocation.value.value.threw) {
      failures.push({
        pluginId: hook.pluginId,
        kind: "threw",
        errorName: invocation.value.value.errorName,
      });
      continue;
    }
    const parsed = routeDecisionSchema.safeParse(invocation.value.value.value);
    if (!parsed.success) {
      failures.push({
        pluginId: hook.pluginId,
        kind: "invalid_decision",
        errorName: null,
      });
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
